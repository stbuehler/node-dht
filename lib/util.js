
var crypto = require('crypto');

exports.debug = false;

function setDebug() {
	if (arguments.length > 0) {
		exports.debug = !!arguments[0];
	}
	return exports.debug;
}
exports.setDebug = setDebug;

function debug() {
	if (exports.debug) {
		console.log.apply(this, arguments);
	}
}
exports.debug = debug;

function buf2hex(buf) {
	var i, l, s, c;
	var hex = "0123456789abcdef";

	if (this instanceof Buffer) buf = this;

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
exports.buf2hex = buf2hex;

if (!Buffer.prototype.toJSON) {
	Buffer.prototype.toJSON = buf2hex;
}

function hex2buf(s) {
	var buf = new Buffer(s.length >> 1), pos, x;
	for (pos = 0; pos < buf.length; ++pos) {
		buf[pos] = parseInt(s.slice(2*pos, 2*pos+2), 16);
	}
	return buf;
}
exports.hex2buf = hex2buf;

function array_append(a) {
	var i, l;
	for (i = 1, l = arguments.length; i < l; ++i) {
		a.push.apply(a, arguments[i]);
	}
}
exports.array_append = array_append;

/* returns seconds */
function time_now() {
	var d = new Date();
	return (d.getTime() / 1000);
}
exports.time_now = time_now;

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
exports.sha1 = sha1;

function buf_dup(b) {
	var r = new Buffer(b.length);
	b.copy(r, 0, 0, b.length);
	return r;
}
exports.buf_dup = buf_dup;

var id_dup = buf_dup;
exports.id_dup = id_dup;

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
exports.id_cmp = id_cmp;

function id_lt(a, b) {
	return -1 === id_cmp(a, b);
}
exports.id_lt = id_lt;
function id_gt(a, b) {
	return  1 === id_cmp(a, b);
}
exports.id_gt = id_gt;
function id_eq(a, b) {
	return  0 === id_cmp(a, b);
}
exports.id_eq = id_eq;

function id_xor(a, b) {
	var i, r = new Buffer(20);
	for (i = 0; i < 20; i++) {
		r[i] = a[i] ^ b[i];
	}
	return r;
}
exports.id_xor = id_xor;

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
exports.id_common = id_common;

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
exports.id_random_with_prefix = id_random_with_prefix;

function generate_id() {
	return sha1(Math.random().toString());
}
exports.generate_id = generate_id;

function generate_tid() {
	return Math.floor(Math.random() * 65536) % 65536;
}
exports.generate_tid = generate_tid;

function tid_to_buffer(tid) {
	return new Buffer([Math.floor(tid / 256), tid % 256]);
}
exports.tid_to_buffer = tid_to_buffer;

function buffer_to_tid(b) {
	if (b.length !== 2) return -1;
	return b[0] * 256 + b[1];
}
exports.buffer_to_tid = buffer_to_tid;

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
exports.short_timeout = short_timeout;

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
exports.decode_node_info = decode_node_info;

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
exports.encode_node_info = encode_node_info;

function decode_peer_info(peer) {
	var i, address, port;

	if (!peer || !(peer instanceof Buffer)) return null;

	if (peer.length !== 6) return null;

	address = [ peer[0], peer[1], peer[2], peer[3] ].join('.');
	port = peer[4] * 256 + peer[5];
	return { address: address, port: port };
}
exports.decode_peer_info = decode_peer_info;

function encode_peer_info(peer) {
	var buf, a;

	buf = new Buffer(6);
	a = peer.address.split('.');
	buf[0] = a[0] | 0; buf[1] = a[1] | 0; buf[2] = a[2] | 0; buf[3] = a[3] | 0;
	buf[4] = (n.port/256) | 0; buf[5] = (n.port % 256);

	return buf;
}
exports.encode_peer_info = encode_peer_info;

function compare_nodes_for(target) {
	return function compares_nodes_for_target(a, b) {
		var i, x, y, t;
		for (i = 0; i < 20; ++i) {
			x = a[i]; y = b[i];
			if (x === y) continue;
			t = target[i];
			return (x ^ t) - (y ^ t);
		}
		return 0;
	}
}
exports.compare_nodes_for = compare_nodes_for;

function accumulate_nodes(nodes, target, node, max) {
	var cmp, i, l, nid;

	if (node.id) {
		cmp = compare_nodes_for(target);
		for (i = 0, l = nodes.length; i < l; ++i) {
			nid = nodes[i].id;
			if (!nid || cmp(node.id, nid) < 0) {
				nodes.splice(i, 0, node);
				if (max && nodes.length > max) nodes.splice(max);
				return;
			}
		}
	}

	if (!max || nodes.length < max) nodes.push(node);
}
exports.accumulate_nodes = accumulate_nodes;
