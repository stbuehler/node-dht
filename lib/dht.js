
var consts_K = 8; /* bucket size */
var consts_MAX_FAIL = 20;
var consts_ALPHA = 3; /* parallel lookups */

var crypto = require('crypto');
var dgram = require('dgram');
var sys = require('sys');

exports.debug = false;

var bencode = require('dht-bencode');

function debug() {
	if (exports.debug) {
		console.log.apply(this, arguments);
	}
}

Buffer.prototype.toJSON = function buf_json() {
	var i, l, s, c;
	var hex = "0123456789abcdef";

	s = "";
	for (i = 0, l = this.length; i < l; ++i) {
		c = this[i];
		if (c == 92) { /* \ */
			s += "\\\\";
		} else if (c >= 32 && c < 128) {
			s += String.fromCharCode(c);
		} else {
			s += "\\x" + hex[(c / 16) | 0] + hex[c % 16];
		}
	}
	return s;
}

/* returns seconds */
function time_now() {
	var d = new Date();
	return (d.getTime() / 1000);
}

/* encoding: 'binary' (default), 'hex', 'base64' */
function sha1(data, encoding) {
	var hash = crypto.createHash('sha1');
	hash.update(data);
	if (!encoding || encoding === 'binary') {
		return new Buffer(hash.digest('base64'), 'base64');
	} else {
		return hash.digest(encoding);
	}
}

function buf_dup(b) {
	var r = new Buffer(b.length);
	b.copy(r, 0, 0, b.length);
	return r;
}

var id_dup = buf_dup;

function id_cmp(a, b) {
	var i, x, y;
	for (i = 0; i < 20; ++i) {
		x = a[i];
		y = b[i];
		if (x < y) return -1;
		if (x > y) return 1;
	}
	return 0; /* equal */
}

function id_lt(a, b) {
	return -1 === id_cmp(a, b);
}
function id_gt(a, b) {
	return  1 === id_cmp(a, b);
}
function id_eq(a, b) {
	return  0 === id_cmp(a, b);
}

function id_xor(a, b) {
	var i, r = new Buffer(20);
	for (i = 0; i < 20; i++) {
		r[i] = a[i] ^ b[i];
	}
	return r;
}

function id_common(a, b) {
	var i, j, x;

	for (i = 0; i < 20; i++) {
		if (a[i] !== b[i]) {
			x = a[i] ^ b[i];
			i = i * 8;
			for (j = 128; j > 0; j >>= 1, i++) {
				if (x & j) return i;
			}
			/* shouldn't end here: at least one bit must be set */
			throw new Error("bad");
		}
	}
	return 160; /* equal */
}

function id_random_with_prefix(id, prefixlen) {
	var r = generate_id(), i, mask;
	i = 0;
	for ( ; prefixlen >= 8; prefixlen -= 8, ++i) {
		r[i] = id[i];
	}
	if (prefixlen > 0) {
		mask = (256 >> prefixlen) - 1;
		r[i] = (id[i] & (255 ^ mask)) | (r[i] & mask);
	}
	return r;
}

function generate_id() {
	return sha1(Math.random().toString());
}

function generate_tid() {
	return Math.floor(Math.random() * 65536) % 65536;
}

function tid_to_buffer(tid) {
	return new Buffer([Math.floor(tid / 256), tid % 256]);
}

function buffer_to_tid(b) {
	if (b.length !== 2) return -1;
	return b[0] * 256 + b[1];
}

/* callback(mode, [other results]): mode = 0: regular result, 1: short timeout, 2: late result */
function short_timeout(timeout, callback) {
	var done = false, late = false;
	var id = setTimeout(function() {
		if (done) return;
		late = true;
		callback(1);
	}, timeout);

	return function() {
		var l;
		if (done) return;
		done = true;
		clearTimeout(id);
		l = Array.prototype.slice.call(arguments);
		l.unshift(late ? 2 : 0);
		callback.apply(null, l);
	};
}

function decode_node_info(nodes) {
	var i, id, address, port, l;

	if (!nodes || !(nodes instanceof Buffer)) return null;

	if (nodes.length % 26 !== 0) return null;

	l = [];
	for (i = 0; i < nodes.length; i += 26) {
		id = buf_dup(nodes.slice(i, i+20));
		address = [ nodes[i+20], nodes[i+21], nodes[i+22], nodes[i+23] ].join('.');
		port = nodes[i+24] * 256 + nodes[i+25];
		l.push({ address: address, port: port, id: id });
	}

	return l;
}

function encode_node_info(nodes) {
	var buf, pos, i, l, n, a;

	buf = new Buffer(nodes.length * 26);
	for (pos = 0, i = 0, l = nodes.length; i < l; i++, pos+=26) {
		n = nodes[i];
		n.id.copy(buf, pos, 0, 20);
		a = n.address.split('.');
		buf[pos+20] = a[0] | 0; buf[pos+21] = a[1] | 0; buf[pos+22] = a[2] | 0; buf[pos+23] = a[3] | 0;
		buf[pos+24] = (n.port/256) | 0; buf[pos+25] = (n.port % 256);
	}

	return buf;
}

function decode_peer_info(peer) {
	var i, address, port;

	if (!peer || !(peer instanceof Buffer)) return null;

	if (peer.length !== 6) return null;

	address = [ peer[0], peer[1], peer[2], peer[3] ].join('.');
	port = peer[4] * 256 + peer[5];
	return { address: address, port: port };
}

function encode_peer_info(peer) {
	var buf, a;

	buf = new Buffer(6);
	a = peer.address.split('.');
	buf[0] = a[0] | 0; buf[1] = a[1] | 0; buf[2] = a[2] | 0; buf[3] = a[3] | 0;
	buf[4] = (n.port/256) | 0; buf[5] = (n.port % 256);

	return buf;
}

function Query(dht, address, port, message) {
	this.dht = dht;
	this.address = address;
	this.port = port;
	this.tid = message.t;
	this.done = false;
}

Query.prototype.respond = function respond(msg) {
	if (this.done) return false;
	this.done = true;
	msg.t = this.tid;
	msg.y = 'r';
	if (undefined === msg.r) msg.r = {};
	msg.r.id = this.dht.id;
	this.dht._send(this.address, this.port, msg);
	return true;
}

Query.prototype.error = function error(code, message) {
	if (this.done) return false;
	this.done = true;
	if (!message) {
		switch (code) {
		case 201: message = 'Generic Error'; break;
		case 202: message = 'Server Error'; break;
		case 203: message = 'Protocol Error'; break;
		case 204: message = 'Method Unknown'; break;
		}
	}
	var msg = { };
	msg.t = this.tid;
	msg.y = 'e';
	msg.e = [code, message];
	this.dht._send(this.address, this.port, msg);
	return true;
}

Query.prototype.getToken = function getToken() {
	this.dht.getToken(this.address, this.port);
}
Query.prototype.verifyToken = function verifyToken(token) {
	this.dht.verifyToken(this.address, this.port, token);
}

function transaction_timeout(transaction) {
	delete transaction.node.transactions[transaction.tid];
	transaction.node.failed();
	transaction.callback(null, transaction.node);
	transaction.node.unqueue();
}

function Transaction(node, tid, message, callback) {
	if (!callback) throw new Error('');
	this.node = node;
	this.tid = tid;
	this.callback = callback;
	this.timeoutID = setTimeout(transaction_timeout, 10000, this);

	message.t = tid_to_buffer(tid);
	message.y = "q";
	if (!message.a) message.a = {};
	message.a.id = node.dht.id;
	node.send(message);
}

Transaction.prototype.response = function response(message) {
	var r, id;

	if ("r" === message.y) {
		r = message.r;
		if (!r || !(r instanceof Object)) return this.node.failed();
		/* check id presence */
		id = r.id;
		if (!id || !(id instanceof Buffer) || id.length != 20) return this.node.failed();
		/* unexpected id */
		if (this.node.id && !id_eq(this.node.id, id)) return this.node.failed();
		this.node.id = id;
	}

	clearTimeout(this.timeoutID);
	delete this.node.transactions[this.tid];

	if (this.node.id) this.node.seen();
	this.callback(message, this.node);
	this.node.unqueue();
}

function Node(dht, address, port, id) {
	this.dht = dht;
	this.address = address;
	this.port = port;
	this.id = id; /* maybe undefined */
	this.key = address + "/" + port;
	this.transactions = {};
	this.queue = [];
}

Node.prototype.find_transaction = function find_transaction(response) {
	var tid;
	if (!response.t || !(response.t instanceof Buffer)) return null;
	tid = buffer_to_tid(response.t);
	if (-1 == tid) return null;
	var t = this.transactions[tid];
	if (!t) return null;
	return t;
}

Node.prototype.send = function send(message) {
	this.dht._send(this.address, this.port, message);
}

Node.prototype.recv = function recv(message) {
	var trans;
	var id;

	switch (message.y) {
	case "q":
		if (!message.q || !(message.q instanceof Buffer)) return null;
		message.q = message.q.toString('ascii');

		if (!message.a || typeof message.a != 'object') return null;
		id = message.a.id;
		if (!id || !(id instanceof Buffer)) return null;
		break;
	case "r":
		trans = this.find_transaction(message);
		if (trans) trans.response(message);
		break;
	case "e":
		trans = this.find_transaction(message);
		if (trans) trans.response(message);
		break;
	default: return; /* invalid */
	}
}

Node.prototype.query = function query(message, callback) {
	if (Object.keys(this.transactions).length >= 5) return this.queue.push([message, callback]);

	if (Object.keys(this.transactions).length == 0) {
		this.dht.active_nodes[this.key] = this;
	}

	var tid;
	do {
		tid = generate_tid();
	} while (this.transactions[tid]);

	this.transactions[tid] = new Transaction(this, tid, message, callback);
}

Node.prototype.unqueue = function unqueue() {
	while (Object.keys(this.transactions).length < 5 && this.queue.length > 0) {
		var x = this.queue.shift();
		this.query(x[0], x[1]);
	}

	if (Object.keys(this.transactions).length == 0) {
		delete this.dht.active_nodes[this.key];
		delete this.dht.active_nodes[this.key];
	}
}

Node.prototype.seen = function seen() {
	if (this.id) this.dht.rtable.node_seen(this.address, this.port, this.id)
}

Node.prototype.failed = function failed() {
	if (this.id) this.dht.rtable.node_failed(this.id)
}

function query_ping(query, message) {
	query.respond({});
}

function query_find_node(query, message) {
	var target = message.a.target;
	if (!target || !(target instanceof Buffer) || target.length != 20) return query.error(203);
	nodes = query.dht.rtable.lookup(target, consts_K, false);
	query.respond({ 'r': { 'nodes' : encode_node_info(nodes) } });
}

function query_get_peers(query, message) {
	var info_hash = message.a.info_hash;
	if (!info_hash || !(info_hash instanceof Buffer) || info_hash.length != 20) return query.error(203);
	nodes = query.dht.rtable.lookup(info_hash, consts_K, false);
	values = query.dht.cache.get(info_hash);
	msg = { 'r': { 'token': query.getToken(), 'nodes' : encode_node_info(nodes) } };
	if (values.length > 0) msg.r.values = values.forEach(encode_peer_info);
	query.respond(msg);
}

function query_announce_peer(query, message) {
	var info_hash = message.a.info_hash;
	if (!info_hash || !(info_hash instanceof Buffer) || info_hash.length != 20) return query.error(203);
	var port = message.a.port;
	if (!port || typeof port != 'number' || port <= 0 || port > 65535) return query.error(203);
	var token = message.a.token;
	if (!token || !(token instanceof Buffer)) return query.error(203);
	if (!query.verifyToken(token)) return query.error(203, "Invalid Token");
	query.dht.rtable.node_seen(query.port, query.address, query.a.id);

	query.dht.cache.add(info_hash, { 'address': query.address, 'port': port });
	query.respond();
}

var query_types = {
	'ping': query_ping,
	'find_node': query_find_node,
	'get_peers': query_get_peers,
	'announce_peer': query_announce_peer,
};

function renew_token(dht) {
	dht.token.push( generate_id() );
	if (dht.token.length > 3) dht.token.shift();
}

function accumulate_nodes(nodes, target, node) {
	var p = id_common(node.id, target), i, l;

	for (i = 0, l = nodes.length; i < l; ++i) {
		if (id_common(nodes[i].id, target) < p) {
			nodes.slice(i, 0, node);
			if (nodes.length > consts_K) nodes.splice(k);
			return;
		}
	}

	if (nodes.length < consts_K) nodes.push(node);
}

function traverse_get_peers(traversal, node, callback) {
	traversal.dht._get_peers(node.address, node.port, node.id, traversal.target, function(response) {
		var nodes, values, i, l, peer, token, peers;
		if (!response) return callback(); /* timeout */

		if (!traversal.peers) { traversal.peers = []; traversal.nodes = []; };

		token = response.r.token;
		if (!token || !(token instanceof Buffer)) return callback();

		accumulate_nodes(traversal.nodes, traversal.target, { 'address': node.address, 'port': node.port, 'id': node.id, 'token': token });

		values = response.r.values;
		peers = [];
		if (values && !Array.isArray(values)) return callback();
		if (values) {
			for (i = 0, l = values.length; i < l; ++i) {
				peer = decode_peer_info(values[i]);
				if (!peer) continue;
				traversal.peers.push(peer);
				peers.push(peer);
			}
		}
		if (traversal.peer_callback && peers.length > 0) traversal.peer_callback(peers);

		nodes = decode_node_info(response.r.nodes);
		callback(nodes);
	});
}

function traverse_refresh(traversal, node, callback) {
	if (node.id && id_eq(node.id, traversal.target)) {
		traversal.dht._ping(node.address, node.port, node.id, function(response) {
			if (!response) return callback(); /* timeout */

			traversal.done();
		});
	} else {
		traversal.dht._find_node(node.address, node.port, node.id, traversal.target, function(response) {
			var nodes;
			if (!response) return callback(); /* timeout */

			nodes = decode_node_info(response.r.nodes);
			if (null === nodes) {
				debug("Unexpected nodes value: ", nodes);
				return callback(); /* invalid/empty response */
			}

			callback(nodes);
		});
	}
}

function Traversal(dht, target, invokecb, callback) {
	this.dht = dht;
	this.target = target;
	this.invokecb = invokecb;
	this.max_requests = 2 * consts_K;
	this.pending = 0;
	this.seen = { };
	this.queue = [ ];
	this.callback = callback;
	this.finished = false;
}

Traversal.prototype.start = function start() {
	if (0 === this.queue.length) {
		this.add_list(this.dht.rtable.lookup(this.target, consts_K, false));
	}

	if (0 === this.queue.length) {
		debug("Cannot connect to DHT without any known nodes");
		this.callback(new Error("Cannot connect to DHT without any known nodes"));
	}

	this.run();
}

Traversal.prototype.run = function run() {
	var n;

	while (!this.finished && this.max_requests != 0 && this.pending < consts_ALPHA && this.queue.length > 0) {
		n = this.queue.shift();
		++this.pending;
		if (this.max_requests > 0) --this.max_requests;
		this.invokecb(this, n, short_timeout(2000, function (shortmode, newnodes) {
			if (this.finished) return;

			if (shortmode !== 2) {
				--this.pending;
			}

			if (newnodes) {
				newnodes.forEach(this.add.bind(this));
				newnodes.forEach(this.dht.rtable.heard_about.bind(this.dht.rtable));
			}

			if (this.abort_id) {
				clearTimeout(this.abort_id);
				delete this.abort_id;
			}

			this.run();
		}.bind(this)));
	}

	if (this.finished) return;

	if ((0 === this.max_requests || 0 === this.queue.length) && 0 === this.pending) {
		this.abort_id = setTimeout(this.done.bind(this), 5000);
	}
}

Traversal.prototype.done = function done() {
	if (this.finished) return;

	if (this.abort_id) {
		clearTimeout(this.abort_id);
		delete this.abort_id;
	}

	this.finished = true;

	this.callback.apply(null, arguments);
}

/* object nodes with: .address, .port and optional .id */
Traversal.prototype.add = function add(node) {
	var i, k, c;

	k = node.address + '/' + node.key;
	if (this.seen[k]) return;
	this.seen[k] = true;

	if (!node.id) {
		this.queue.push(node);
		return;
	}

	c = id_common(node.id, this.target);

	for (i in this.queue) {
		var n = this.queue[i];

		if (!n.id || id_common(n.id, this.target) < c) {
			this.queue.splice(i, 0, node);
			return;
		}
	}

	this.queue.push(node);
}

Traversal.prototype.add_list = function add_list(nodes) {
	var i, n, k;

	for (i in nodes) {
		n = nodes[i];
		k = n.address + '/' + n.port;
		if (this.seen[k]) continue;

		this.seen[k] = true;
		this.queue.push(n);
	}
}


function DHT(port) {
	var s4, s6;

	this.id = generate_id();

	this.socket4 = s4 = dgram.createSocket('udp4');
	s4.bind(port || 0);
	this.port = s4.address().port;

// 	this.socket6 = s6 = dgram.createSocket('udp6');
// 	s6.bind(this.port, "::");

	s4.on('message', this._recv.bind(this));
// 	s6.on('message', this._recv.bind(this));

	/* nodes that expect a response, key: address + '/' + port */
	this.active_nodes = {};

	this.rtable = new RoutingTable(this);

	this.cache = new Cache();

	this.version = "Node.JS";

	this.token = [ generate_id() ];
	this.token_intervalID = setInterval(renew_token, 5*60*1000, this);
}

exports.DHT = DHT;

DHT.prototype._get_node = function get_node(address, port, id) {
	var n, key = address + '/' + port;

	n = this.active_nodes[key];
	if (n) return n;

	this.active_nodes[key] = n = new Node(this, address, port, id);
	return n;
}

DHT.prototype._send = function send(address, port, message) {
	var buf;
	message.v = this.version;
	debug('Sending (to %s:%s): %j', address, port, message);
	try {
		buf = bencode.bencode(message);
		this.socket4.send(buf, 0, buf.length, port, address);
	} catch (e) {
		console.log("Couldn't send:", e);
	}
}

DHT.prototype._recv = function recv(msg, rinfo) {
	var data, query, qtype, qhandler, node;

	try {
		data = bencode.bdecode(msg);
	} catch (e) {
		console.log("Couldn't decode message (from %s:%s) %j: %s", rinfo.address, rinfo.port, msg, e);
		return;
	}
	debug('Receiving (from %j): %j', rinfo, data);
	if (data) {
		/* check message type */
		if (!data.y || !(data.y instanceof Buffer)) return; /* ignore */
		data.y = data.y.toString('ascii');
		if (data.y != 'r' && data.y != 'e' && data.y != 'q') return; /* ignore */

		/* check transaction id */
		if (!data.t || !(data.t instanceof Buffer)) return; /* ignore */

		if (data.y == 'q') {
			query = new Query(this, rinfo.address, rinfo.port, data);
			qtype = data.q;
			if (!qtype || !(qtype instanceof Buffer)) return query.error(203);
			data.q = qtype = qtype.toString('ascii');
			qhandler = query_types[qtype];
			if (!qhandler) return query.error(204);
			qhandler(query, data);
		} else {
			node = this.active_nodes[rinfo.address + "/" + rinfo.port];
			if (node) node.recv(data);
		}
	}
}

DHT.prototype.getToken = function getToken(address, port) {
	var curtoken = this.token[this.token.length-1];
	return sha1(curtoken.toString('base64') + address + "/" + port);
}

DHT.prototype.verifyToken = function verifyToken(address, port, token) {
	var b64 = token.toString('base64');
	for (var i in this.token) {
		if (b64 == sha1(this.token[i].toString('base64') + address + "/" + port, 'base64')) return true;
	}
	return false;
}

DHT.prototype.lookup = function lookup(info_hash, callback) {
	var t = new Traversal(this, info_hash, traverse_get_peers, function() {
		callback(t.peers, true);
	});
	t.peer_callback = function(peers) {
		callback(peers, false);
	}
	t.max_requests += 100;
	t.start();
}

DHT.prototype.announce = function announce(info_hash, port) {
	var t = new Traversal(this, target, traverse_get_peers, function() {
		var i, l, n;
		if (!t.nodes) {
			debug("couldn't find any node to announce '%s' @ %s", info_hash, port);
			return;
		}
		for (i = 0, l = t.nodes.length; i < l; ++i) {
			n = this.nodes[i];
			this._announce_peer(n.address, n.port, n.id, info_hash, port, n.token, function() { });
		}
	}.bind(this));
	t.max_requests += 100;
	t.start();
}

DHT.prototype._ping = function _ping(address, port, id, callback) {
	var node = this._get_node(address, port, id);
	node.query({ 'q': 'ping' }, callback);
}

DHT.prototype._find_node = function _find_node(address, port, id, target, callback) {
	var node = this._get_node(address, port, id);
	node.query({ 'q': 'find_node', 'a': { 'target': target } }, callback);
}

DHT.prototype._get_peers = function _get_peers(address, port, id, info_hash, callback) {
	var node = this._get_node(address, port, id);
	node.query({ 'q': 'get_peers', 'a': { 'info_hash': info_hash } }, callback);
}

DHT.prototype._announce_peer = function _announce_peer(address, port, id, info_hash, myport, token, callback) {
	var node = this._get_node(address, port, id);
	node.query({ 'q': 'announce_peer', 'a': { 'info_hash': info_hash, 'port': myport, 'token': token } }, callback);
}

DHT.prototype._refresh = function _refresh(target) {
	var t = new Traversal(this, target, traverse_refresh, function() {});
	t.start();
}

DHT.prototype.bootstrap = function bootstrap(nodes) {
	var t = new Traversal(this, this.id, traverse_refresh, function() {});
	t.add_list(nodes);
	t.max_requests += nodes.length;
	t.start();
}

function RTNode(address, port, id, failed_pings) {
	this.address = address.toString();
	this.port = port | 0;
	this.id = id_dup(id);
	this.failed_pings = failed_pings; // -1 means not pinged yet
}

function rtnode_eq(a, b) {
	return (a.address === b.address && a.port === b.port && id_eq(a, b));
}

function RouteEntry() {
	this.live = [];
	this.replacement = [];
	this.last_refresh = 160;
}

RouteEntry.prototype.split = function split(own_id, own_ndx) {
	var nbucket = new RouteEntry(), i, l;
	var old;

	old = this.live;
	this.live = [];
	for (i = 0, l = old.length; i < l; ++i) {
		if (id_common(own_id, old[i]) > own_ndx) {
			nbucket.live.push(old[i]);
		} else {
			this.live.push(old[i]);
		}
	}

	old = this.replacement;
	this.replacement = [];
	for (i = 0, l = old.length; i < l; ++i) {
		if (id_common(own_id, old[i]) > own_ndx) {
			if (nbucket.live.length < consts_K) {
				nbucket.live.push(old[i]);
			} else {
				nbucket.replacement.push(old[i]);
			}
		} else {
			if (this.live.length < consts_K) {
				this.live.push(old[i]);
			} else {
				this.replacement.push(old[i]);
			}
		}
	}

	nbucket.last_refresh = 160 - own_ndx - 1;

	return nbucket;
}

function Cache() {
	this.store = {};
}

Cache.prototype.get = function get(key) {
	return [];
}

Cache.prototype.add = function add(key, value) {
}

function RoutingTable(dht) {
	this.dht = dht;
	/* index is the length of the common prefix with this.dht.id; last bucket catches all remaining */
	this.table = [ new RouteEntry() ];
	this.refresh_id = setInterval(this._refresh.bind(this), 5000);
	this.last_refresh = 0;
	this.last_self_refresh = 0;
}

RoutingTable.prototype._refresh = function _refresh() {
	var i, min_ndx, min_time, t, bucket, now = time_now();
	if (now - this.last_self_refresh > 15*60) {
		this.last_self_refresh = now;
		this.dht._refresh(this.dht.id);
		return;
	}

	if (now - this.last_refresh < 15*60) return;

	min_ndx = -1;
	min_time = now + consts_K * 5;
	for (i in this.table) {
		bucket = this.table[i];
		t = bucket.last_refresh + bucket.live.length * 5;
		if (t < min_time) {
			t = min_time;
			min_ndx = i;
		}
	}

	if (-1 === min_ndx) return;

	bucket = this.table[min_ndx];
	if (now - bucket.last_refresh < 45) return;

	this.last_refresh = now;
	this.dht._refresh(id_random_with_prefix(this.dht.id, min_ndx));
}

RoutingTable.prototype._find_bucket = function find_bucket(id) {
	var ndx = id_common(this.dht.id, id);
	if (ndx >= this.table.length) ndx = this.table.length - 1;
	return ndx;
}

RoutingTable.prototype._add_node = function add_node(node) {
	var i, n, ndx, bucket, nbucket, can_split, max_fail_ndx, max_fail;

	if (id_eq(node.id, this.dht.id)) return;

	ndx = this._find_bucket(node.id);
	bucket = this.table[ndx];

	for (i in bucket.live) {
		n = bucket.live[i];
		if (id_eq(n.id, node.id)) {
			/* move to back, update */
			bucket.live.splice(i, 1);
			/* only update if old address failed and new node was pinged */
			bucket.live.push( (node.failed_pings === 0 && n.failed_pings !== 0) ? node : n );
			return;
		}
	}

	for (i in bucket.replacement) {
		n = bucket.replacement[i];
		if (id_eq(n.id, node.id)) {
			/* move to back, update */
			bucket.replacement.splice(i, 1);
			/* only update if old address failed and new node was pinged */
			bucket.replacement.push( (node.failed_pings === 0 && n.failed_pings !== 0) ? node : n );
			return;
		}
	}

	/* new node */
	if (bucket.live.length < consts_K) {
		bucket.live.push(node);
		return;
	}

	can_split = false;

	if (0 === node.failed_pings) {
		can_split = (ndx == this.table.length - 1) && (ndx < 159);

		max_fail_ndx = -1;
		max_fail = 0; /* higher fail limit before replacing a node? */
		for (i in bucket.live) {
			n = bucket.live[i];
			if (-1 === n.failed_pings) {
				/* replace unpinged n with node */
				bucket.live.splice(i, 1);
				bucket.live.push(node);
				return;
			} else if (n.failed_pings > max_fail) {
				max_fail_ndx = i;
				max_fail = n.failed_pings;
			}
		}

		if (-1 !== max_fail_ndx) {
			/* replace node that failed most with new node */
			bucket.live.splice(max_fail_ndx, 1);
			bucket.live.push(node);
			return;
		}
	}

	if (!can_split) {
		if (bucket.replacement.length >= consts_K) {
			max_fail_ndx = -1;
			max_fail = -1;
			for (i in bucket.replacement) {
				n = bucket.replacement[i];
				if (-1 === n.failed_pings) {
					/* replace unpinged n with node */
					bucket.replacement.splice(i, 1);
					bucket.replacement.push(node);
					return;
				} else if (n.failed_pings > max_fail) {
					max_fail_ndx = i;
					max_fail = n.failed_pings;
				}
			}

			/* only replace good nodes if the new node is good too */
			if (-1 !== max_fail_ndx && (max_fail > 0 || node.failed_pings === 0)) {
				bucket.replacement.splice(max_fail, 1);
				bucket.replacement.push(node);
				return;
			}
		} else {
			bucket.replacement.push(node);
		}

		return;
	}

	/* split */
	nbucket = bucket.split(this.dht.id, ndx);
	this.table.push(nbucket);

	/* try adding now */
	ndx = this._find_bucket(node.id);
	bucket = this.table[ndx];
	if (bucket.live.length < consts_K) {
		bucket.live.push(node);
	} else if (bucket.replacement.length < consts_K) {
		bucket.replacement.push(node);
	}
}

RoutingTable.prototype.node_seen = function node_seen(address, port, id) {
	this._add_node(new RTNode(address, port, id, 0));
}

RoutingTable.prototype.heard_about = function heard_about(node) {
	this._add_node(new RTNode(node.address, node.port, node.id, -1));
}

RoutingTable.prototype.node_failed = function node_failed(id) {
	var ndx, bucket, i, node;

	ndx = this._find_bucket(id);
	bucket = this.table[ndx];

	for (i in bucket.live) {
		node = bucket.live[i];
		if (id_eq(node.id, id)) {
			if (0 == bucket.replacement.length) {
				if (-1 === node.failed_pings || node.failed_pings+1 >= consts_MAX_FAIL) {
					/* remove node */
					bucket.live.splice(i, 1);
				}
				++node.failed_pings;
			} else {
				/* remove node */
				bucket.live.splice(i, 1);
				/* replace with "good" node */
				for (i in bucket.replacement) {
					node = bucket.replacement[i];
					if (0 === node.failed_pings) {
						bucket.replacement.splice(i, 1);
						bucket.live.push(node);
						return;
					}
				}
				/* or the first if no good node was found */
				bucket.live.push(bucket.replacement.shift());
			}
			return;
		}
	}
	/* was not a live node */

	for (i in bucket.replacement) {
		node = bucket.replacement[i];
		if (id_eq(node.id, id)) {
			/* remove node */
			bucket.replacement.splice(i, 1);
			return;
		}
	}
}

RoutingTable.prototype.lookup = function lookup(id, count, include_failed) {
	var ndx, bucket, i, node, r = [];

	if (-1 === count) include_failed = true;

	ndx = this._find_bucket(id);
	bucket = this.table[ndx];
	if (include_failed) {
		r.push.apply(r, bucket.live);
	} else {
		bucket.live.forEach(function (n) { if (0 === n.failed_pings) r.push(n); });
	}

	i = ndx + 1;
	while ((-1 === count || r.length < count) && i < this.table.length) {
		bucket = this.table[i];
		if (include_failed) {
			r.push.apply(r, bucket.live);
		} else {
			bucket.live.forEach(function (n) { if (0 === n.failed_pings) r.push(n); });
		}
		++i;
	}

	i = ndx -1 ;
	while ((-1 === count || r.length < count) && i >= 0) {
		bucket = this.table[i];
		if (include_failed) {
			r.push.apply(r, bucket.live);
		} else {
			bucket.live.forEach(function (n) { if (0 === n.failed_pings) r.push(n); });
		}
		--i;
	}

	if (count >= 0) r.splice(count);
	return r;
}
