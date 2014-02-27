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
var url = require('url');
var tty = require('tty')
var cursor = require('ansi')(process.stdout);
var events = require('events');

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
        verbosity: 1,
        parallel: 10,
        quiet: false
    }, opts);


    var logv = function (level, message) {
        if (opts.quiet || level > opts.verbosity)
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


    var waitNextSyncTimeout = 0;

    var totalFileCount = 0;
    var currentDownloading = 0;


    var downloadQueue = [];
    var downloadQueueEvents = new events.EventEmitter();

    var enqueueDownload = function (sync, fileData, target) {
        if (waitNextSyncTimeout)
            clearTimeout(waitNextSyncTimeout);
        downloadQueue.push({
            sync: sync,
            fileData: fileData,
            target: target,
            number: totalFileCount + 1
        });
        totalFileCount += 1;
        if (currentDownloading < opts.parallel) {
            downloadQueueEvents.emit("next", currentDownloading);
            currentDownloading += 1;
        }
    }

    downloadQueueEvents.on("next", function (slot) {
        if (downloadQueue.length == 0) {
            currentDownloading -= 1;
            if (currentDownloading == 0) {
                // queue is empty and all files downloaded
                if (!opts.quiet)
                    // reset cursor to the end
                    cursor.down(2 * totalFileCount+1).horizontalAbsolute(0).reset();
                if (opts.wait) {
                    logv(1, ("Waiting " + opts.wait + "seconds for next execution...").cyan);
                    waitNextSyncTimeout = setTimeout(this.startSync, opts.wait*1000);
                }
            }
            return;
        }
        var toDownload = downloadQueue.shift();
        downloadFile(toDownload.sync, toDownload.fileData, toDownload.target, slot, toDownload.number);
    });

    var downloadFile = function (sync, fileData, target, slot, number) {
        //logv(0, ("Downloading " + fileData.name + " to: " + target).magenta);
        var downloadUrl = api.files.download(fileData.id);

        var current = path.resolve(target);
        var parent = path.dirname(current);
        ensureDir(parent, undefined, function (err) {
            if (err) {
                logv(0, ("Coudln't create directory: " + parent + " -> " + err).red);
                return;
            }

            request({
                url: downloadUrl,
                followRedirect: false
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

                    var tempFilename = path.join(path.join(sync.local_path, download_temp_dir), fileData.id + "-" + path.basename(target));

                    var bytesOffset = 0;
                    if (fs.existsSync(tempFilename)) {
                        bytesOffset = fs.statSync(tempFilename).size;
                    }

                    var bar = null;
                    if (!opts.quiet)
                        bar = statusBar.create({ total: fileData.size - bytesOffset })
                            //var bar = statusBar.create({ total: fileData.size })
                            .on("render", function (stats) {
                                cursor.down(2 * slot).horizontalAbsolute(0).grey().write(
                                        "[" + number + " of " + totalFileCount + "] ").cyan().write(filename + "\r\n").white().write(this.format.storage(stats.currentSize + bytesOffset) + "/" + this.format.storage(fileData.size) + "), " +
                                        this.format.speed(stats.speed) + " " +
                                        this.format.time(stats.remainingTime) + " [" +
                                        this.format.progressBar(stats.percentage) + "] " +
                                        this.format.percentage(stats.percentage) + "\r\n").up(2 * (slot + 1)).reset();
                            });

                    var urlObj = url.parse(newUrl);

                    https.get({
                        'host': urlObj.host,
                        'port': 443,
                        'path': urlObj.path,
                        method: 'GET',
                        headers: {
                            'Range': 'bytes=' + bytesOffset + "-"
                        }
                    },function (res) {
                        var file = fs.createWriteStream(tempFilename, {
                            'flags': bytesOffset === 0 ? 'w' : 'a'
                        });
                        if (!opts.quiet)
                            res.pipe(bar);
                        res.on('data', function (chunk) {
                            file.write(chunk);
                            //bar.write(chunk);
                        });
                        res.on('end', function () {
                            file.end();
                            //bar.end();
                        });
                        file.on('close', function () {
                            fs.rename(tempFilename, target, function () {
                                if (!opts.quiet)
                                    cursor.down(2 * slot + 1).horizontalAbsolute(0).eraseLine().white().write("DOWNLOADED").up(2 * slot + 1).reset();
                                downloadQueueEvents.emit("next", slot);
                                if (sync.delete) {
                                    api.files.delete(fileData.id, function (delData) {
                                        if (delData.status !== "OK")
                                            logv(0, ("Coudln't delete file '" + file.name + "' put.io").red);
                                    })
                                }
                            })
                        });

                    }).on("error", function (error) {
                            if (!opts.quiet)
                                bar.cancel();
                            logv(0, error.red);
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
                                    enqueueDownload(sync, file, localFile);
                                }
                            });
                        } else {
                            // file doesn't exist locally -> download
                            enqueueDownload(sync, file, localFile);
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

    this.startSync = function() {
        totalFileCount = 0;
        currentDownloading = 0;
        downloadQueue = [];

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

    this.startSync();



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