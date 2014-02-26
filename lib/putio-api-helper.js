"use strict;"

var _ = require('underscore');

var PutIOApiHelper = function (api) {

    /**
     * Traverses through the put.io filesystem to get the id of the folder path
     * @param path string[] containing the successive folder names
     * @param parentId id of the current parent folder
     * @param depth current recursion depth
     * @param callback success callback
     */
    var findFolderIdRecursive = function (path, parentId, depth, callback) {
        api.files.list(parentId, function (data) {
            var found = _.find(data.files, function(entry) {
                return (entry.content_type === "application/x-directory") && entry.name === path[depth];
            });
            if (typeof found === "undefined")
                callback(undefined);
            else {
                if (path.length == depth+1) {
                    callback(found.id);
                }
                else
                    findFolderIdRecursive(path, found.id, depth + 1, callback);
            }
        });
    }

    /**
     * Gets the folder ID of the given folder path from put.io file system
     * @param folderPath the path identifying the folder. e.g 'Folder1/Subfolder2'
     * @param callback the callback with the id as parameter
     */
    this.findFolderId = function (folderPath, callback) {
        findFolderIdRecursive(folderPath.split('/'), 0, 0, callback);
    }
}

var root = this;

// Export the Class object for **Node.js**, with
// backwards-compatibility for the old `require()` API. If we're in
// the browser, add `PutIOApiHelper` as a global object via a string identifier,
// for Closure Compiler "advanced" mode.
if (typeof exports !== 'undefined') {
    if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = PutIOApiHelper;
    }
    exports.PutIOApiHelper = PutIOApiHelper;
} else {
    root.PutIOSync = PutIOApiHelper;
}