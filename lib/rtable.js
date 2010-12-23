
var util = require('./util');
var consts = require('./consts');

function RTNode(address, port, id, failed_pings) {
	this.address = address.toString();
	this.port = port | 0;
	this.id = util.id_dup(id);
	this.failed_pings = failed_pings; // -1 means not pinged yet
}

function rtnode_eq(a, b) {
	return (a.address === b.address && a.port === b.port && util.id_eq(a, b));
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
		if (util.id_common(own_id, old[i]) > own_ndx) {
			nbucket.live.push(old[i]);
		} else {
			this.live.push(old[i]);
		}
	}

	old = this.replacement;
	this.replacement = [];
	for (i = 0, l = old.length; i < l; ++i) {
		if (util.id_common(own_id, old[i]) > own_ndx) {
			if (nbucket.live.length < consts.K) {
				nbucket.live.push(old[i]);
			} else {
				nbucket.replacement.push(old[i]);
			}
		} else {
			if (this.live.length < consts.K) {
				this.live.push(old[i]);
			} else {
				this.replacement.push(old[i]);
			}
		}
	}

	nbucket.last_refresh = 160 - own_ndx - 1;

	return nbucket;
}

function RoutingTable(dht) {
	this.dht = dht;
	/* index is the length of the common prefix with this.dht.id; last bucket catches all remaining */
	this.table = [ new RouteEntry() ];
	this.last_refresh = 0;
	this.last_self_refresh = 0;
}

exports.RoutingTable = RoutingTable;

RoutingTable.prototype.start = function start() {
	this.refresh_id = setInterval(this._refresh.bind(this), 5000);
}

RoutingTable.prototype.stop = function stop() {
	clearInterval(this.refresh_id);
}

RoutingTable.prototype._refresh = function _refresh() {
	var i, min_ndx, min_time, t, bucket, now = util.time_now();
	if (now - this.last_self_refresh > 15*60) {
		this.last_self_refresh = now;
		this.dht._refresh(this.dht.id);
		return;
	}

	if (now - this.last_refresh < 15*60) return;

	min_ndx = -1;
	min_time = now + consts.K * 5;
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
	this.dht._refresh(util.id_random_with_prefix(this.dht.id, min_ndx));
}

RoutingTable.prototype._find_bucket = function find_bucket(id) {
	var ndx = util.id_common(this.dht.id, id);
	if (ndx >= this.table.length) ndx = this.table.length - 1;
	return ndx;
}

RoutingTable.prototype._add_node = function add_node(node) {
	var i, n, ndx, bucket, nbucket, can_split, max_fail_ndx, max_fail;

	if (util.id_eq(node.id, this.dht.id)) return;

	ndx = this._find_bucket(node.id);
	bucket = this.table[ndx];

	for (i in bucket.live) {
		n = bucket.live[i];
		if (util.id_eq(n.id, node.id)) {
			/* move to back, update */
			bucket.live.splice(i, 1);
			/* only update if old address failed and new node was pinged */
			bucket.live.push( (node.failed_pings === 0 && n.failed_pings !== 0) ? node : n );
			return;
		}
	}

	for (i in bucket.replacement) {
		n = bucket.replacement[i];
		if (util.id_eq(n.id, node.id)) {
			/* move to back, update */
			bucket.replacement.splice(i, 1);
			/* only update if old address failed and new node was pinged */
			bucket.replacement.push( (node.failed_pings === 0 && n.failed_pings !== 0) ? node : n );
			return;
		}
	}

	/* new node */
	if (bucket.live.length < consts.K) {
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
		if (bucket.replacement.length >= consts.K) {
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
	if (bucket.live.length < consts.K) {
		bucket.live.push(node);
	} else if (bucket.replacement.length < consts.K) {
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
		if (util.id_eq(node.id, id)) {
			if (0 == bucket.replacement.length) {
				if (-1 === node.failed_pings || node.failed_pings+1 >= consts.MAX_FAIL) {
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
		if (util.id_eq(node.id, id)) {
			/* remove node */
			bucket.replacement.splice(i, 1);
			return;
		}
	}
}

RoutingTable.prototype.lookup = function lookup(id, count, include_failed) {
	var ndx, bucket, i, node, r = [], rx, cmp;

	if (-1 === count) include_failed = true;

	cmp = util.compare_nodes_for(id);

	ndx = this._find_bucket(id);
	bucket = this.table[ndx];
	if (include_failed) {
		util.array_append(r, bucket.live.slice().sort(cmp));
	} else {
		util.array_append(r, bucket.live.filter(function (n) { return (0 === n.failed_pings); }).sort(cmp));
	}

	if (-1 === count || r.length < count) {
		i = ndx + 1;
		rx = [];
		while (i < this.table.length) {
			bucket = this.table[i];
			if (include_failed) {
				util.array_append(rx, bucket.live);
			} else {
				util.array_append(rx, bucket.live.filter(function (n) { return (0 === n.failed_pings); }));
			}
			++i;
		}
		rx.sort(cmp);
		util.array_append(r, rx);
	}

	if (-1 === count || r.length < count) {
		i = ndx -1 ;
		rx = [];
		while ((-1 === count || r.length < count) && i >= 0) {
			bucket = this.table[i];
			if (include_failed) {
				util.array_append(rx, bucket.live);
			} else {
				util.array_append(rx, bucket.live.filter(function (n) { return (0 === n.failed_pings); }));
			}
			--i;
		}
		rx.sort(cmp);
		util.array_append(r, rx);
	}

	if (count >= 0) r.splice(count);
	return r;
}
