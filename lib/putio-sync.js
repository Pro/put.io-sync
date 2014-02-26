"use strict;"

var PutIO = require('put.io-v2');
var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var npid = require('npid');
var colors = require('colors');
var ensureDir = require('ensureDir');
var fswin = require('fswin');
var request = require('request');
var pass=require('stream').PassThrough;

var https = require("https");
var statusBar = require("status-bar");

var PutIOApiHelper = require(path.join(path.dirname(fs.realpathSync(__filename)), 'putio-api-helper.js'));

var projectBase = path.join(path.dirname(fs.realpathSync(__filename)), '../');

var PutIOSync = function (opts) {
    // Set default options
    /**
     * Available options:
     * config:  Path to config file relative to main project directory
     */
    if (typeof opts === "undefined")
        opts = {};
    opts = _.extend({
        config: "config.js",
        verbosity: 999
    }, opts);


    var logv = function (level, message) {
        if (level > opts.verbosity)
            return;
        console.log(message);
    }

    // Load configuration
    var config = require(path.join(projectBase, opts.config));


    // Ensure monogamy
    try {
        npid.create(path.join(projectBase, "sync.pid"));
    } catch (err) {
        if (!opts.override) {
            if (err.code === 'EEXIST') {
                fs.readFile(path.join(projectBase, "sync.pid"), 'utf8', function (err, data) {
                    if (err) {
                        logv(0, err);
                    } else {
                        logv(0, ("Another instance is already running with PID: " + data).red);
                    }
                    process.exit(1);
                });
            } else {
                logv(0, err);
                process.exit(1);
            }
        }
    }

    var api = new PutIO(config.oauth_token);
    var apiHelper = new PutIOApiHelper(api);

    var download_temp_dir = ".putiosync-downloading";

    var fileCount = 0;

    var downloadFile = function (sync, fileData, target) {
        //logv(0, ("Downloading " + fileData.name + " to: " + target).magenta);
        var downloadUrl = api.files.download(fileData.id);
        if (fileCount === 0)
            //clear console
            process.stdout.write("\033[2J");
        fileCount += 1;

        var currentFile = fileCount;

        var current = path.resolve(target);
        var parent = path.dirname(current);
        ensureDir(parent, undefined, function (err) {
            if (err) {
                logv(0, ("Coudln't create directory: " + parent + " -> " + err).red);
                return;
            }


            request({
                url : downloadUrl,
                followRedirect : false
            }, function (error, response, body) {
                if (response.statusCode === 302) {
                    var newUrl = response.headers.location;
                    var formatFilename = function (filename) {
                        //80 - 59
                        var filenameMaxLength = 80;
                        if (filename.length > filenameMaxLength) {
                            filename = filename.slice(0, filenameMaxLength - 3) + "...";
                        } else {
                            var remaining = filenameMaxLength - filename.length;
                            while (remaining--) {
                                filename += " ";
                            }
                        }
                        return filename;
                    };

                    var filename = formatFilename(fileData.name);

                    var temp_filename = path.join(path.join(sync.local_path,download_temp_dir), path.basename(target));

                    https.get(newUrl,function (res) {
                        bar = statusBar.create({ total: fileData.size })
                            .on("render", function (stats) {
                                process.stdout.write("\033[" + (currentFile*2)+";0H");
                                process.stdout.write(
                                    filename.cyan + "\n(" + this.format.storage(stats.currentSize) + "/" + this.format.storage(stats.totalSize) + "), " +
                                        this.format.speed(stats.speed) + " " +
                                        this.format.time(stats.remainingTime) + " [" +
                                        this.format.progressBar(stats.percentage) + "] " +
                                        this.format.percentage(stats.percentage));
                            });
                        var file = fs.createWriteStream(temp_filename);

                        res.pipe(bar);
                        res.on('data', function(chunk) {
                            file.write(chunk);
                            //bar.write(chunk);
                        });
                        res.on('end', function() {
                            file.end();
                            //bar.end();
                        });
                        file.on('close', function() {
                            fs.rename(temp_filename, target, function() {
                                console.log("END");
                                if (sync.delete) {
                                    api.files.delete(fileData.id, function (delData) {
                                        if (delData.status !== "OK")
                                            logv(0, ("Coudln't delete file '" + file.name + "' put.io").red);
                                    })
                                }
                            })
                        });

                    }).on("error", function (error) {
                            bar.cancel();
                            console.error(error);
                        });
                } else {
                    logv(0, ("Expected 302 status code but got " + response.statusCode + " for file " + fileData.name).red);
                }
            })




        });
    }

    var syncFolderRecursive = function (sync, folderId, localPath, depth) {
        api.files.list(folderId, function (data) {
            // check if folder should be deleted
            if (sync.delete_subfolder && depth > 0 && data.files.length == 0) {
                logv(1, ("Folder '" + data.parent.name + "' is empty. Deleting ...").green);
                api.files.delete(folderId, function (delData) {
                    if (delData.status !== "OK")
                        logv(0, ("Couldn't delete folder '" + data.parent.name + "'").red);
                });
                return;
            }

            _.each(data.files, function (file) {
                var localFile = path.join(localPath, file.name.replace(':', '_'));//Replace colon, otherwise subfolders will fail
                localFile = localFile.replace(' \\', '\\'); //Remove whitespace before slash, otherwise subfolders will fail
                if (file.content_type === "application/x-directory") {
                    if (!sync.recursive)
                        return;
                    // recursive step into directory
                    syncFolderRecursive(sync, file.id, localFile, depth + 1);
                } else {
                    //check if local file already exists
                    fs.exists(localFile, function (exists) {
                        if (exists) {
                            // check if local size is equal to remote file size
                            fs.stat(localFile, function (err, stats) {
                                if (stats.size === file.size) {
                                    logv(2, ("File '" + file.name + "' already exists and will be skipped").yellow);
                                    if (sync.delete) {
                                        // delete remote file
                                        api.files.delete(file.id, function (delData) {
                                            if (delData.status === "OK")
                                                logv(1, ("File '" + file.name + "' deleted on put.io").green);
                                            else
                                                logv(0, ("Coudln't delete file '" + file.name + "' put.io").red);
                                        })
                                    }
                                } else {
                                    logv(1, ("File '" + file.name + "' exists but has a different size. Will be redownloaded").yellow);
                                    downloadFile(sync, file, localFile);
                                }
                            });
                        } else {
                            // file doesn't exist locally -> download
                            downloadFile(sync, file, localFile);
                        }
                    });
                }

            });
        });
    }

    /**
     * Sync the given remote and local path
     * @param sync sync config section
     */
    var syncFolder = function (sync) {
        logv(1, ("Syncing folder '" + sync.remote_path + "' to '" + sync.local_path + "'...").yellow);
        apiHelper.findFolderId(sync.remote_path, function (id) {
            if (typeof id === "undefined") {
                logv(0, ("Remote folder '" + sync.remote_path + "' not found").red);
                return;
            }
            syncFolderRecursive(sync, id, sync.local_path, 0);

        })
    }

    _.each(config.sync, function (sync) {
        // Create download temp dir
        var tempDir = path.join(sync.local_path, download_temp_dir);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
            fswin.setAttributesSync(tempDir, { IS_HIDDEN: true });
        }

        // Trim leading and trailing slashes from the source path
        sync.remote_path = sync.remote_path.replace(/^\/|\/$/gi, '');

        fs.exists(sync.local_path, function (exists) {
            if (exists) {
                syncFolder(sync);
            } else {
                logv(0, ("The local folder '" + sync.local_path + "' doesn't exist").red)
            }
        });
    });


}

// Establish the root object, `window` in the browser, or `exports` on the server.
var root = this;

// Export the Class object for **Node.js**, with
// backwards-compatibility for the old `require()` API. If we're in
// the browser, add `PutIOSync` as a global object via a string identifier,
// for Closure Compiler "advanced" mode.
if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = PutIOSync;
    }
    exports.PutIOSync = PutIOSync;
} else {
    root.PutIOSync = PutIOSync;
}