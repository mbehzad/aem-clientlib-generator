/*
 *  Copyright (c) 2016 pro!vision GmbH and Contributors
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 *
 */

"use strict";

var async = require("async");
var path = require("path");
var _ = require("lodash");
var fs = require("fs");
var fse = require("fs-extra");
var glob = require("glob");

/**
 * @typedef {Object} ClientLibItem
 * @property {String} path - Clientlib root path (optional if `options.clientLibRoot` is set)
 * @property {String} name - Clientlib name
 * @property {Array<String>} [embed] - other Clientlib names that should be embedded
 * @property {Array<String>} [dependencies] - other Clientlib names that should be included
 * @property {Array<String>} [cssProcessor] - Clientlib processor specification for CSS
 * @property {Array<String>} [jsProcessor] - Clientlib processor specification for JS
 * @property {Array<Object>} assets - content that should be copied to the clientlib folder, more details below
 */

/**
 * Check if the given file exists
 * @param file
 * @returns {boolean}
 */
function fileExists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch(e) {
    return false;
  }
}

/**
 * Removes clientlib folder and configuration file (JSON) for the given
 * clientlib item.
 * @param {ClientLibItem} item - clientlib properties
 * @param {Object} [options] - further options
 * @param {Function} done - callback to be invoked after
 */
function removeClientLib(item, options, done) {
  var configJson = path.join(item.path, item.name + ".json");
  var clientLibPath = path.join(item.path, item.name);
  var files = [];

  if (_.isFunction(options)) {
    done = options;
    options = {};
  }
  if (fileExists(configJson)) {
    files.push(configJson);
  }
  if (fileExists(clientLibPath)) {
    files.push(clientLibPath);
  }

  if (files.length === 0) {
    return done();
  }

  options.verbose && console.log("remove clientlib from " + clientLibPath);
  if (options.dry) {
    return done();
  }
  async.eachSeries(files, function(file, doneClean) {
    fse.remove(file, doneClean);
  }, done);
}

/**
 * Write the clientlib asset TXT file (js or css) that describes the
 * base and contains all resource paths.
 * @param {String} clientLibPath - path to the clientlib folder
 * @param {Object} asset - asset object
 */
function writeAssetTxt(clientLibPath, asset, options) {

  if (!asset || !asset.type || !_.isArray(asset.files)) {
    return;
  }
  var outputFile = path.join(clientLibPath, asset.type + ".txt");
  var basePath = path.join(clientLibPath, asset.base);

  // determines file path relative to the base
  var filenames = [];
  var typeExt = "." + asset.type;

  options.verbose && console.log("write clientlib asset txt file (type: " + asset.type + "): " + outputFile);

  asset.files.forEach(function(file){

    // inject only files that correspondents to the asset type
    if (path.extname(file.dest) === typeExt) {
      var rel = path.relative(basePath, file.dest);
      filenames.push(rel);
    }
  });

  var content = "#base=" + asset.base + "\n\n" + filenames.join("\n");
  content.trim();

  if (!options.dry) {
    fs.writeFileSync(outputFile, content);
  }
}

/**
 * Write a configuration JSON file for a clientlib
 * with the given properties in `item`
 * @param {ClientLibItem} item - clientlib configuration properties
 * @param {Object} options - further options
 */
function writeClientLibJson(item, options) {
  var content = {
    'jcr:primaryType': 'cq:ClientLibraryFolder',
    'categories': [item.name]
  };

  ['embed', 'dependencies', 'cssProcessor', 'jsProcessor'].forEach(function(nodeKey) {
    if (item.hasOwnProperty(nodeKey)) {
      content[nodeKey] = item[nodeKey];
    }
  });

  var jsonFile = path.join(item.path, item.name + ".json");
  options.verbose && console.log("write clientlib json file: " + jsonFile);
  if (!options.dry) {
    fse.writeJsonSync(jsonFile, content, {spaces: 2});
  }
}

/**
 * Iterate through the given array of clientlib configuration objects and
 * process them asynchronously.
 * @param {Array<ClientLibItem>} itemList - array of clientlib configuration items
 * @param {Object} [options] - global configuration options
 * @param {Function} done - to be called if everything is done
 */
function start(itemList, options, done) {

  if (_.isFunction(options)) {
    done = options;
    options = {};
  }

  if (!_.isArray(itemList)) {
    itemList = [itemList];
  }

  if (options.context || options.cwd) {
    options.cwd = options.context || options.cwd;
    process.chdir(options.cwd);
  }

  if (options.verbose) {
    console.log("\nstart aem-clientlib-generator");
    console.log("  working directory: " + process.cwd());
  }
  options.dry && console.log("\nDRY MODE - without write options!");

  async.eachSeries(itemList, function(item, processItemDone){
    processItem(item, options, processItemDone);
  }, done);
}

/**
 * Normalize different asset configuration options.
 * @param {String} clientLibPath - clientlib subfolder
 * @param {Object} assets - asset configuration object
 * @returns {*}
 */
function normalizeAssets(clientLibPath, assets) {

  var list = assets;

  // transform object to array
  if (!_.isArray(assets)) {
    list = [];
    _.keys(assets).forEach(function(assetKey){
      var assetItem = assets[assetKey];

      // check/transform short version
      if (_.isArray(assetItem)) {
        assetItem = {
          files: assetItem
        };
      }
      if (!assetItem.base) {
        assetItem.base = assetKey;
      }
      assetItem.type = assetKey;
      list.push(assetItem);
    });
  }

  // transform files to scr-dest mapping
  list.forEach(function(asset){

    var mapping = [];
    var flatName = typeof asset.flatten !== "boolean" ? true : asset.flatten;
    var assetPath = path.join(clientLibPath, asset.base);
    var globOptions = {};
    if (asset.cwd) {
      globOptions.cwd = asset.cwd;
    }

    asset.files.forEach(function(file){
      var fileItem = file;

      // convert simple syntax to object
      if (_.isString(file)) {
        fileItem = {
          src: file
        };
      }

      // no magic pattern -> default behaviour
      if (!glob.hasMagic(fileItem.src)) {

        // determine default dest
        if (!fileItem.dest) {
          fileItem.dest = path.basename(file);
        }

        // generate full path
        fileItem.dest = path.join(assetPath, fileItem.dest);
        mapping.push(fileItem);
      }

      // resolve magic pattern
      else {
        var files = glob.sync(fileItem.src, globOptions);
        var hasCwd = !!globOptions.cwd;
        var dest = fileItem.dest ? path.join(assetPath, fileItem.dest) : assetPath;

        files.forEach(function(resolvedFile) {

          // check 'flatten' option -> strip dir name
          var destFile = flatName ? path.basename(resolvedFile) : resolvedFile;

          var item = {
            src: resolvedFile,
            dest: path.join(dest, destFile)
          };

          // check "cwd" option -> rebuild path, because it was stripped by glob.sync()
          if (hasCwd) {
            item.src = path.join(globOptions.cwd, resolvedFile);
          }

          mapping.push(item);
        });
      }
    });

    asset.files = mapping;
  });

  return list;
}

/**
 * Process the given clientlib configuration object.
 * @param {ClientLibItem} item - clientlib configuration object
 * @param {Object} options - configuration options
 * @param {Function} processDone - to be called if everything is done
 */
function processItem(item, options, processDone) {

  if (!item.path) {
    item.path = options.clientLibRoot;
  }

  options.verbose && console.log("\n\nprocessing clientlib: " + item.name);

  // remove current files if exists
  removeClientLib(item, function(err) {

    var clientLibPath = path.join(item.path, item.name);

    // create clientlib directory
    fse.mkdirsSync(clientLibPath);

    // write configuration JSON
    writeClientLibJson(item, options);

    var assetList = normalizeAssets(clientLibPath, item.assets);

    // iterate through assets
    async.eachSeries(assetList, function(asset, assetDone){

      // write clientlib creator files
      if (asset.type === "js" || asset.type === "css") {
        options.verbose && console.log("");
        writeAssetTxt(clientLibPath, asset, options);
      }

      // copy files for given asset
      async.eachSeries(asset.files, function(fileItem, copyDone) {

        options.verbose && console.log("copy:", fileItem.src, fileItem.dest);
        if (options.dry) {
          return copyDone();
        }

        // create directories separately or it will be copied recursively
        if (fs.lstatSync(fileItem.src).isDirectory()) {
          fs.mkdir(fileItem.dest, copyDone);
        }
        else {
          fse.copy(fileItem.src, fileItem.dest, copyDone);
        }
      }, assetDone);

    }, processDone);
  });
}

module.exports = start;
module.exports.removeClientLib = removeClientLib;
module.exports.fileExists = fileExists;