"use strict;"

var windows = false;

var PutIO = require('put.io-v2');
var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var npid = require('npid');
var colors = require('colors');
var ensureDir = require('ensureDir');
var fswin = null;
if(process.platform == 'win32' || process.platform == 'win64'){
  fswin = require('fswin');
  windows = true;
}
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
    var self = this;

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

    /**
     * Log message with specified log level
     * @param level the log level. 0=error, 5 = very verbose
     * @param message the message to log
     */
    var logv = function (level, message) {
        if (opts.quiet || level > opts.verbosity)
            return;
        console.log(message);
    }

    /**
     * Load the configuration.
     * @type {object}
     */
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

    /**
     * The Api to communicate with Put.io
     * @type {PutIO}
     */
    var api = new PutIO(config.oauth_token);
    /**
     * Helper combining some api functions
     * @type {PutIOApiHelper}
     */
    var apiHelper = new PutIOApiHelper(api);

    /**
     * Temporary download directory
     * @type {string}
     */
    var download_temp_dir = ".putiosync-downloading";

    /**
     * Timer id for the next sync run timeout
     * @type {number}
     */
    var waitNextSyncTimeout = 0;

    /**
     * Number of files to download
     * @type {number}
     */
    var totalFileCount = 0;
    /**
     * Number of currently active downloads
     * @type {number}
     */
    var currentDownloading = 0;

    /**
     * The download queue containing all the files to download
     * @type {Array}
     */
    var downloadQueue = [];
    /**
     * EventEmitter for download queue notifications.
     * @type {events.EventEmitter}
     */
    var downloadQueueEvents = new events.EventEmitter();

    /**
     * Add file to download queue and start the download if a slot is available.
     * @param sync Sync section from the config file
     * @param fileData put.io file info object
     * @param target local file path where to store downloaded file
     */
    var enqueueDownload = function (sync, fileData, target) {
        if (waitNextSyncTimeout)
            clearTimeout(waitNextSyncTimeout);  //reset timer if running
        downloadQueue.push({
            sync: sync,
            fileData: fileData,
            target: target,
            number: totalFileCount + 1
        });
        totalFileCount += 1;
        if (currentDownloading < opts.parallel) {
            // there's a slot available, start downloading
            downloadQueueEvents.emit("next", currentDownloading);
            currentDownloading += 1;
        }
    }

    /**
     * Wait opts.wait seconds and then start a new sync run.
     */
    var waitForNextExecution = function () {
        if (opts.wait) {
            logv(1, ("Waiting " + opts.wait + " seconds for next execution...").cyan);
            waitNextSyncTimeout = setTimeout(self.startSync, opts.wait * 1000);
        }
    }

    /**
     * Event triggered after a download finished or a new one has been added to the queue and there's a slot available.
     * @param slot index where the status bar can be shown
     */
    downloadQueueEvents.on("next", function (slot) {
        if (downloadQueue.length == 0) {
            currentDownloading -= 1;
            if (currentDownloading == 0) {
                // queue is empty and all files downloaded
                if (!opts.quiet)
                // reset cursor to the end
                    cursor.down(2 * Math.min(totalFileCount, opts.parallel) + 1).horizontalAbsolute(0).reset();
                waitForNextExecution();
            }
            return;
        }
        var toDownload = downloadQueue.shift();
        downloadFile(toDownload.sync, toDownload.fileData, toDownload.target, slot, toDownload.number);
    });

    /**
     * Shorten a filename if it is longer than given maximum length. Add ellipsis points '...'
     * @param filename filename to shorten
     * @param filenameMaxLength maximum length of the resulting string
     * @returns {string} the shortened filename
     */
    var formatFilename = function (filename, filenameMaxLength) {
        if (filename.length > filenameMaxLength) {
            filename = filename.slice(0, filenameMaxLength - 3) + "...";
        }
        return filename;
    };

    /**
     * Download the file to the temporary download directory and then move it to the final target path.
     * @param sync Sync section from config file
     * @param fileData put.io file data object
     * @param target target file path where to store the file
     * @param slot index where to show download info and progress
     * @param number index of the download within the queue of all the downloads.
     */
    var downloadFile = function (sync, fileData, target, slot, number) {
        //logv(0, ("Downloading " + fileData.name + " to: " + target).magenta);
        var downloadUrl = api.files.download(fileData.id);

        var current = path.resolve(target);
        var parent = path.dirname(current);
        // make sure target path exists
        ensureDir(parent, undefined, function (err) {
            if (err) {
                logv(0, ("Coudln't create directory: " + parent + " -> " + err).red);
                return;
            }

            // get the url where we can fetch the file
            request({
                url: downloadUrl,
                followRedirect: false
            }, function (error, response, body) {
                if (response.statusCode === 302) {
                    // yayy! We got the url in the location header
                    var newUrl = response.headers.location;

                    var filename = formatFilename(fileData.name, 80);

                    var tempFilename = path.join(path.join(sync.local_path, download_temp_dir), fileData.id + "-" + path.basename(target));

                    // check if file already partially downloaded
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

                    // start download
                    https.get({
                        'host': urlObj.host,
                        'port': 443,
                        'path': urlObj.path,
                        method: 'GET',
                        headers: {
                            'Range': 'bytes=' + bytesOffset + "-"
                        }
                    },function (res) {
                        // temporary file to store the content
                        var file = fs.createWriteStream(tempFilename, {
                            'flags': bytesOffset === 0 ? 'w' : 'a'
                        });
                        if (!opts.quiet)
                            res.pipe(bar);
                        res.on('data', function (chunk) {
                            file.write(chunk);
                        });
                        res.on('end', function () {
                            file.end();
                        });
                        file.on('close', function () {
                            // move file to final location
                            fs.rename(tempFilename, target, function () {
                                if (!opts.quiet)
                                    cursor.down(2 * slot + 1).horizontalAbsolute(0).eraseLine().white().write("DOWNLOADED").up(2 * slot + 1).reset();
                                // start next download
                                downloadQueueEvents.emit("next", slot);
                                if (sync.delete) {
                                    // delete file on put.io
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

    /**
     * Iterate through folder with given id and enqueue all the files for download.
     *
     * @param sync Sync section from the config file
     * @param folderId id of the folder to download
     * @param localPath local target path where to store the folder contents
     * @param depth current recursion depth
     */
    var syncFolderRecursive = function (sync, folderId, localPath, depth) {
        api.files.list(folderId, function (data) {
            // check if folder is empty and should be deleted
            if (sync.delete_subfolder && depth > 0 && data.files.length == 0) {
                logv(1, ("Folder '" + data.parent.name + "' is empty. Deleting ...").green);
                api.files.delete(folderId, function (delData) {
                    if (delData.status !== "OK")
                        logv(0, ("Couldn't delete folder '" + data.parent.name + "'").red);
                });
                return;
            }

            _.each(data.files, function (file) {
                // check folder content
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

    /**
     * Start the sync process
     */
    this.startSync = function () {
        totalFileCount = 0;
        currentDownloading = 0;
        downloadQueue = [];
        waitNextSyncTimeout = 0;

        _.each(config.sync, function (sync) {
            // Create download temp dir
            var tempDir = path.join(sync.local_path, download_temp_dir);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
                if(windows){
                  fswin.setAttributesSync(tempDir, { IS_HIDDEN: true });
                }
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

        setTimeout(function () {
            if (currentDownloading == 0 && downloadQueue.length == 0 && waitNextSyncTimeout == 0)
                waitForNextExecution();
        }, 1000);
    }
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