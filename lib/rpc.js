
var util = require('./util');
var consts = require('./consts');

function Query(dht, address, port, message) {
	this.dht = dht;
	this.address = address;
	this.port = port;
	this.tid = message.t;
	this.done = false;
}

exports.Query = Query;

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

Query.prototype.handle = function handle(data) {
	var qtype, qhandler, node;
	qtype = data.q;
	if (!qtype || !(qtype instanceof Buffer)) return this.error(203);
	data.q = qtype = qtype.toString('ascii');
	qhandler = query_types[qtype];
	if (!qhandler) return this.error(204);
	qhandler(this, data);
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

	message.t = util.tid_to_buffer(tid);
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
		if (this.node.id && !util.id_eq(this.node.id, id)) return this.node.failed();
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
exports.Node = Node;

Node.prototype.find_transaction = function find_transaction(response) {
	var tid;
	if (!response.t || !(response.t instanceof Buffer)) return null;
	tid = util.buffer_to_tid(response.t);
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
		tid = util.generate_tid();
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
	nodes = query.dht.rtable.lookup(target, consts.K, false);
	query.respond({ 'r': { 'nodes' : util.encode_node_info(nodes) } });
}

function query_get_peers(query, message) {
	var info_hash = message.a.info_hash;
	if (!info_hash || !(info_hash instanceof Buffer) || info_hash.length != 20) return query.error(203);
	nodes = query.dht.rtable.lookup(info_hash, consts.K, false);
	values = query.dht.cache.get(info_hash);
	msg = { 'r': { 'token': query.getToken(), 'nodes' : util.encode_node_info(nodes) } };
	if (values.length > 0) msg.r.values = values.forEach(util.encode_peer_info);
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

