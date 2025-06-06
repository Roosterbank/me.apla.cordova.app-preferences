var mappings = require("./mappings"),
	platformName = "android";

module.exports = function (context) {

	var
		Q = require('q'),
		path = require('path'),
		ET = require('elementtree'),
		cordova = require('cordova'),
		cordova_lib = cordova.cordova_lib,
		ConfigParser = cordova_lib.configparser,
		cordova_util = require('cordova-lib/src/cordova/util'),
		ofs = require("fs"),
		fs = require("./filesystem")(Q, require('fs'), path),
		platforms = {};

	// fs, path, ET, cordova_util, ConfigParser

	// Check the currente platform version and map the path of resources
	function getResPath(){
		return path.join('platforms','android','app','src','main','res');
	}

	// Check the currente platform version and map the path of Java
	function getJavaPath(){
		return path.join('platforms','android','app','src','main','java');
	}

	function mapConfig(config) {
		var element = {
			attrs: {},
			children: []
		};

		if (!config.type) {
			throw "no type defined for "+JSON.stringify (config, null, "\t");
		}

		var mapping = mappings[config.type];

		if (!mapping)
			throw "no mapping for "+ config.type;

		element.tagname = mapping[platformName];

		if (mapping.required) {
			mapping.required.forEach (function (k) {
				if (!(k in config)) {
					throw ['attribute', k, 'not found for', config.title, '(' + config.type + ')'].join (" ");
				}
			});
		}

		if (mapping.attrs) {
			for (var attrName in mapping.attrs) {
				if (!config.hasOwnProperty(attrName))
					continue;
				var attrConfig = mapping.attrs[attrName];
				var elementKey = attrConfig[platformName];

				var targetCheck = elementKey.split ('@');
				var targetAttr;
				if (targetCheck.length === 2 && targetCheck[0] === '') {
					targetAttr = targetCheck[1];
					if (!element.attrs)
						element.attrs = {};
					element.attrs[targetAttr] = [];
				}
				if (attrConfig.value) {
					if (!attrConfig.value[config[attrName]] || !attrConfig.value[config[attrName]][platformName])
						throw "no mapping for type: "+ config.type + ", attr: " + attrName + ", value: " + config[attrName];
					if (targetAttr)
						element.attrs[targetAttr].push (attrConfig.value[config[attrName]][platformName]);
					else
						element[elementKey] = attrConfig.value[config[attrName]][platformName]
				} else {

					if (targetAttr)
						element.attrs[targetAttr].push (config[attrName]);
					else
						element[elementKey] = config[attrName];
				}
			}
		}

		if (mapping.fixup && mapping.fixup[platformName]) {
			mapping.fixup[platformName] (element, config, mapping);
		}

		return element;
	}

	function buildNode(parent, config, stringsArrays) {

		for (var attr in config.attrs) {
			if (config.attrs[attr] && config.attrs[attr].constructor === Array)
				config.attrs[attr] = config.attrs[attr].join ('|');
		}

		var newNode = new ET.SubElement(parent, config.tagname);
		newNode.attrib = config.attrs;

		if (config.strings) {
			console.log("will push strings array "+JSON.stringify(config.strings));
			stringsArrays.push(config.strings);
		}

		if (config.children) {
			config.children.forEach(function(child){
				buildNode(newNode, child, stringsArrays);
			});
		}
	}


	// build Android settings XML
	function buildSettings(configJson) {
		var screenNode = new ET.Element('PreferenceScreen'),
			resourcesNode = new ET.Element('resources'),
			stringsArrays = [];

		screenNode.set('xmlns:android', 'http://schemas.android.com/apk/res/android');

		// Generate base settings file
		configJson.forEach(function (preference) {
			var node = mapConfig(preference);

			if (preference.type === 'group' && preference.items && preference.items.length) {
				preference.items.forEach(function(childNode) {
					node.children.push(mapConfig(childNode));
				});
			}

			buildNode(screenNode, node, stringsArrays);
		});

		// Generate resource file
		stringsArrays.forEach(function (stringsArray) {
			var titlesXml = new ET.SubElement(resourcesNode, 'string-array'),
				valuesXml = new ET.SubElement(resourcesNode, 'string-array');

			titlesXml.set("name", "apppreferences_" + stringsArray.name);
			valuesXml.set("name", "apppreferences_" + stringsArray.name + 'Values');

			for (var i=0, l=stringsArray.titles.length; i<l; i++) {
				var titleItemXml = new ET.SubElement(titlesXml, "item"),
					valueItemXml = new ET.SubElement(valuesXml, "item");

				titleItemXml.text = stringsArray.titles[i];
				valueItemXml.text = stringsArray.values[i];
			}
		});

		return {
			preferencesDocument: new ET.ElementTree(screenNode),
			preferencesStringDocument: new ET.ElementTree(resourcesNode)
		};
	}

	function build(config) {
		var settingsDocuments = buildSettings(config),
			preferencesDocument = settingsDocuments.preferencesDocument,
			preferencesStringDocument = settingsDocuments.preferencesStringDocument;

		var pathXml    = null;
		var pathValues = null;
		return fs.exists('platforms/android')
			// Check version Platfom installed
			.then(function () {
				return getResPath();
			})
			// Write preferences xml file
			.then(function (pathRes) {
				pathXml    = path.join(pathRes, 'xml');
				pathValues = path.join(pathRes, 'values');
				return fs.mkdir(pathXml);
			})
			.then(function () { return fs.writeFile( path.join(pathXml,'apppreferences.xml'), preferencesDocument.write()); })

			// Write localization resource file
			.then(function () { return fs.mkdir(pathValues); })
			.then(function (prefs) { return fs.writeFile( path.join(pathValues,'apppreferences.xml'), preferencesStringDocument.write()); })

			.then(function () { console.log('android preferences file was successfully generated'); })
			.catch(function (err) {
				if (err.code === 'NEXIST') {
					console.log("Platform android not found: skipping");
					return;
				}

				throw err;
			});
	}

	function afterPluginInstall () {
		var pathJava = null;
		return fs.exists('platforms/android')
			// Check version Platfom installed
			.then(function () {
				return getJavaPath();
			})
			// Import preferences into native android project
			.then(function (pathJ) {
				pathJava = pathJ;
				return fs.readFile(path.resolve(__dirname, '../../src/android/AppPreferencesActivity.template'));
			})
			.then(function (tmpl) {
				var projectRoot = cordova_lib.cordova.findProjectRoot(process.cwd()),
					projectXml = cordova_util.projectConfig(projectRoot),
					projectConfig = new ConfigParser(projectXml);

				var packageName = projectConfig.android_packageName() || projectConfig.packageName();

				return (
					//'package me.apla.cordova;\n\n' +
					//'import ' + packageName + '.R;\n\n' +
					tmpl.toString ('utf8').replace (/ANDROID_PACKAGE_NAME/g, packageName)
				);
			})
			.then(function (data) {
				var androidPackagePath = "me.apla.cordova".replace (/\./g, '/');
				var activityFileName= path.join (pathJava, androidPackagePath, 'AppPreferencesActivity.java');
				return fs.writeFile(activityFileName, data);
			})

			.catch(function (err) {
				if (err.code === 'NEXIST') {
					console.log("Platform android not found: skipping");
					return;
				}

				throw err;
			});

	}

	function clean(config) {

		var androidPackagePath = "me.apla.cordova".replace (/\./g, '/');
		var activityFileName = null;

		var pathXml    = null;
		var pathValues = null;
		return fs.exists('platforms/android')
			// Check version Platfom installed
			.then(function () {
				return getResPath();
			})

			// Remove preferences xml file
			.then(function (pathRes) {
				pathXml    = path.join(pathRes, 'xml');
				pathValues = path.join(pathRes, 'values');
				return fs.unlink( path.join(pathXml,'apppreferences.xml') );
			})

			// Remove localization resource file
			.then(function (prefs) {
				return fs.unlink( path.join(pathValues,'apppreferences.xml') );
			})

			// Check version Platfom installed
			.then(function () {
				return getJavaPath();
			})

			// Remove preferences from native android project
			.then(function (pathJava) {
				activityFileName = path.join (pathJava, androidPackagePath, 'AppPreferencesActivity.java');
				return fs.unlink(activityFileName);
			})

			.then(function () { console.log('android preferences file was successfully cleaned'); })
			.catch(function (err) {
				if (err.code === 'NEXIST') {
					console.log("Platform android not found: skipping");
					return;
				} else if (err.code === 'ENOENT' && err.path === activityFileName) {
					// Activity not generated, that's fine
					return;
				}

				throw err;
			});
	}

	return {
		mapConfig: mapConfig,
		buildSettings: buildSettings,

		build: build,
		afterPluginInstall: afterPluginInstall,
		clean: clean
	};
};
