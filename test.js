var path = require ("path");
var http = require ("http");
var statusBar = require ("status-bar");

var url = "http://nodejs.org/dist/latest/node.exe";
var bar;

http.get (url, function (res){
  bar = statusBar.create ({ total: res.headers["content-length"] })
      .on ("render", function (stats){
        process.stdout.write (
            path.basename (url) + " " +
            " (" + this.format.storage(stats.currentSize) + "/" + this.format.storage(stats.totalSize) + "), " +
            this.format.speed (stats.speed) + " " +
            this.format.time (stats.remainingTime) + " [" +
            this.format.progressBar (stats.percentage) + "] " +
            this.format.percentage (stats.percentage));
        process.stdout.cursorTo (0);
      });

  res.pipe (bar);
}).on ("error", function (error){
  bar.cancel ();
  console.error (error);
});