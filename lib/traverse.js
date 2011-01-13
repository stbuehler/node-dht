
var util = require('./util');
var consts = require('./consts');

function traverse_get_peers(traversal, node, callback) {
	traversal.dht._get_peers(node.address, node.port, node.id, traversal.target, function(response) {
		var nodes, values, i, l, peer, token, peers;
		if (!response) return callback(); /* timeout */

		if (!traversal.peers) { traversal.peers = []; traversal.nodes = []; };

		token = response.r.token;
		if (!token || !(token instanceof Buffer)) return callback();

		util.accumulate_nodes(traversal.nodes, traversal.target, { 'address': node.address, 'port': node.port, 'id': node.id, 'token': token }, consts.K);

		values = response.r.values;
		peers = [];
		if (values && !Array.isArray(values)) return callback();
		if (values) {
			for (i = 0, l = values.length; i < l; ++i) {
				peer = util.decode_peer_info(values[i]);
				if (!peer) continue;
				traversal.peers.push(peer);
				peers.push(peer);
			}
		}
		if (traversal.peer_callback && peers.length > 0) traversal.peer_callback(peers);

		nodes = util.decode_node_info(response.r.nodes);
		callback(nodes);
	});
}

exports.traverse_get_peers = traverse_get_peers;


function traverse_refresh(traversal, node, callback) {
	if (node.id && util.id_eq(node.id, traversal.target)) {
		traversal.dht._ping(node.address, node.port, node.id, function(response) {
			if (!response) return callback(); /* timeout */

			traversal.done();
		});
	} else {
		traversal.dht._find_node(node.address, node.port, node.id, traversal.target, function(response) {
			var nodes;
			if (!response) return callback(); /* timeout */

			nodes = util.decode_node_info(response.r.nodes);
			if (null === nodes) {
				util.debug("Unexpected nodes value: ", nodes);
				return callback(); /* invalid/empty response */
			}

			callback(nodes);
		});
	}
}

exports.traverse_refresh = traverse_refresh;

function Traversal(dht, target, invokecb, callback) {
	this.dht = dht;
	this.target = target;
	this.invokecb = invokecb;
	this.max_requests = 2 * consts.K;
	this.pending = 0;
	this.seen = { };
	this.queue = [ ];
	this.callback = callback;
	this.finished = false;
}

exports.Traversal = Traversal;

Traversal.prototype.start = function start() {
	if (0 === this.queue.length) {
		this.add_list(this.dht.rtable.lookup(this.target, consts.K, false));
	}

	if (0 === this.queue.length) {
		util.debug("Cannot connect to DHT without any known nodes");
		this.callback(new Error("Cannot connect to DHT without any known nodes"));
	}

	this.run();
}

Traversal.prototype.run = function run() {
	var n;

	while (!this.finished && this.max_requests != 0 && this.pending < consts.ALPHA && this.queue.length > 0) {
		n = this.queue.shift();
		++this.pending;
		if (this.max_requests > 0) --this.max_requests;
		this.invokecb(this, n, util.short_timeout(2000, function (shortmode, newnodes) {
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

	util.accumulate_nodes(this.queue, this.target, node);
}

/* list is assumed to be "sorted" - otherwise use nodes.forEach(traversal.add.bind(traversal)); */
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
