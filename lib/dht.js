
var dgram = require('dgram');

var util = require('./util');
var consts = require('./consts');
var rtable = require('./rtable');
var traverse = require('./traverse');
var rpc = require('./rpc');
var cache = require('./cache');
var bencode = require('dht-bencode');

exports.setDebug = util.setDebug;
exports.util = util;
exports.consts = consts;

function renew_token(dht) {
	dht.token.push( util.generate_id() );
	if (dht.token.length > 3) dht.token.shift();
}

function DHT(port) {
	var s4, s6;

	this.started = false;

	this.id = util.generate_id();

	this.socket4 = s4 = dgram.createSocket('udp4');
	s4.bind(port || 0);
	this.port = s4.address().port;

// 	this.socket6 = s6 = dgram.createSocket('udp6');
// 	s6.bind(this.port, "::");

	/* nodes that expect a response, key: address + '/' + port */
	this.active_nodes = {};

	this.rtable = new rtable.RoutingTable(this);

	this.cache = new cache.Cache();

	this.version = "Node.JS";

	this.token = [ util.generate_id() ];
	this.token_intervalID = setInterval(renew_token, 5*60*1000, this);
}

exports.DHT = DHT;

DHT.prototype.start = function start() {
	if (this.started) return;
	this.started = true;

	this.socket4.on('message', this._recv.bind(this));
// 	this.socket6.on('message', this._recv.bind(this));

	this.rtable.start();
	this.cache.start();
}

DHT.prototype.stop = function start() {
	if (!this.started) return;
	this.started = false;

	this.socket4.removeAllListeners('message');
// 	this.socket6.removeAllListeners('message');

	this.rtable.stop();
	this.cache.stop();
}


DHT.prototype._get_node = function _get_node(address, port, id) {
	var n, key = address + '/' + port;

	n = this.active_nodes[key];
	if (n) return n;

	this.active_nodes[key] = n = new (rpc.Node)(this, address, port, id);
	return n;
}

DHT.prototype._send = function send(address, port, message) {
	var buf;
	message.v = this.version;
	util.debug('Sending (to %s:%s): %j', address, port, message);
	try {
		buf = bencode.bencode(message);
		this.socket4.send(buf, 0, buf.length, port, address);
	} catch (e) {
		console.log("Couldn't send: %s", e.stack);
	}
}

DHT.prototype._recv = function recv(msg, rinfo) {
	var data, query, node;

	try {
		data = bencode.bdecode(msg);
	} catch (e) {
		console.log("Couldn't decode message (from %s:%s) %j: %s", rinfo.address, rinfo.port, msg, e);
		return;
	}
	util.debug('Receiving (from %j): %j', rinfo, data);
	if (data) {
		/* check message type */
		if (!data.y || !(data.y instanceof Buffer)) return; /* ignore */
		data.y = data.y.toString('ascii');
		if (data.y != 'r' && data.y != 'e' && data.y != 'q') return; /* ignore */

		/* check transaction id */
		if (!data.t || !(data.t instanceof Buffer)) return; /* ignore */

		if (data.y == 'q') {
			query = new rpc.Query(this, rinfo.address, rinfo.port, data);
			query.handle(data);
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
	var t = new traverse.Traversal(this, info_hash, traverse.traverse_get_peers, function() {
		callback(t.peers, true);
	});
	t.peer_callback = function(peers) {
		callback(peers, false);
	}
	t.max_requests += 100;
	t.start();
}

DHT.prototype.announce = function announce(info_hash, port) {
	var t = new traverse.Traversal(this, target, traverse.traverse_get_peers, function() {
		var i, l, n;
		if (!t.nodes) {
			util.debug("couldn't find any node to announce '%s' @ %s", info_hash, port);
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
	var t = new traverse.Traversal(this, target, traverse.traverse_refresh, function() {});
	t.start();
}

DHT.prototype.bootstrap = function bootstrap(nodes) {
	var t = new traverse.Traversal(this, this.id, traverse.traverse_refresh, function() {});
	t.add_list(nodes);
	t.max_requests += nodes.length;
	t.start();
}
