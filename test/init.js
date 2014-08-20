var tap = require('tap')

tap.test('The putio-sync module loads', function(t) {
  t.doesNotThrow(load_app, 'Test loading the putio-sync.js file')
  t.end()

  function load_app() {
    var PutIOSync = require('../lib/putio-sync')
  }
})

tap.test('startSync function available', function(t) {
  var PutIOSync = require('../lib/putio-sync');
  var sync = new PutIOSync({config: 'config.js.template'});
  t.type(sync.startSync, 'function', 'Check if startSync function available')
  t.end()
})
