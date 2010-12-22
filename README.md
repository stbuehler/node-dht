# dht

[DHT](http://bittorrent.org/beps/bep_0005.html "BitTorrent DHT spec") implementation.

## install

	npm install dht

## usage

	var DHT = require('dht').DHT;
	var dht = new DHT(51414);

	// require('dht').debug = true;

	var dht = new DHT();
	// for bootstrapping you need to know a node which already is in the dht
	dht.bootstrap([ { 'address': 'xxx.xxx.xxx.xxx', 'port': xxx } ]);

	function hex2buf(s) {
		var buf = new Buffer(s.length >> 1), pos, x;
		for (pos = 0; pos < buf.length; ++pos) {
			buf[pos] = parseInt(s.slice(2*pos, 2*pos+2), 16);
		}
		return buf;
	}

	var id = hex2buf("640FE84C613C17F663551D218689A64E8AEBEABE");

	dht.lookup(id, function (peers, finished) {
		console.log("Found more peers: %j", peers);
		if (finished) console.log("Lookup done");
	});

## status

Local hashtable not implemented (needs to handle timeout of peers); announce not tested.
