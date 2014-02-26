"use strict;"

var PutIO = require('put.io-v2');
var _ = require('underscore');
var fs = require('fs');

var PutIOSync = function (opts) {
    // Set default options
    if (typeof opts === "undefined")
        opts = {};
    _.extend({
        config : "config.json"
    }, opts);

    var configuration = JSON.parse(
        fs.readFileSync(opts.config)
    );

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