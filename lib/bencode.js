/* http://natsuki.weeaboo.se:8080/~valderman/files/bencode.js */
/* Copyright (c) 2009 Anton Ekblad

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software. */

/* modified by Stefan Buehler to use node.js Buffers (c) 2010 */

if (!Buffer.prototype.charAt) Buffer.prototype.charAt = function charAt(i) {
	return String.fromCharCode(this[i]);
};

// bencode an object
function bencode(obj) {
	switch(btypeof(obj)) {
		case "string":     return bstring(obj);
		case "number":     return bint(obj);
		case "list":       return blist(obj);
		case "dictionary": return bdict(obj);
		default:           return null;
	}
}

exports.bencode = bencode;

// decode a bencoded string into a javascript object
function bdecode(str) {
	var dec = bparse(str, 0);
	if(dec != null && dec[1] == str.length)
		return dec[0];
	return null;
}

exports.bdecode = bdecode;

// parse a bencoded string; bdecode is really just a wrapper for this one.
// all bparse* functions return an array in the form
// [parsed object, remaining string to parse]
function bparse(str, pos) {
	switch(str.charAt(pos)) {
		case "d": return bparseDict(str, pos+1);
		case "l": return bparseList(str, pos+1);
		case "i": return bparseInt(str, pos+1);
		default:  return bparseString(str, pos);
	}
}

function findchar(str, pos, c) {
	while (pos < str.length) {
		if (str.charAt(pos) == c) return pos;
		pos++;
	}
	return -1;
}

function copy(str, start, len) {
	return str.slice(start, start+len);
// 	var buf = new Buffer(len);
// 	str.copy(buf, 0, start, start+len);
// 	return buf;
}

// parse a bencoded string
function bparseString(str, pos) {
	var colon = findchar(str, pos, ':');
	if (-1 == colon) return null;
	var str2 = str.toString('ascii', pos, colon);
	if(isNum(str2)) {
		var len = parseInt(str2);
		return [ copy(str, colon+1, len), colon+1+len ];
	}
	return null;
}

// parse a bencoded integer
function bparseInt(str, pos) {
	var end = findchar(str, pos, 'e');
	if (-1 == colon) return null;
	var str2 = str.toString('ascii', pos, end);
	if(!isNum(str2))
		return null;
	return [Number(str2), end+1];
}

// parse a bencoded list
function bparseList(str, pos) {
	var p, list = [];
	while(pos < str.length && str.charAt(pos) != "e") {
		p = bparse(str);
		if (null == p) return null;
		list.push(p[0]);
		pos = p[1];
	}
	if (pos >= str.length) return null;
	return [list, pos+1];
}

// parse a bencoded dictionary
function bparseDict(str, pos) {
	var key, val, dict = {};
	while (pos < str.length && str.charAt(pos) != "e") {
		key = bparseString(str, pos);
		if (null == key) return null;
		pos = key[1];
		if (pos >= str.length) return null;

		val = bparse(str, pos);
		if (null == val) return null;

		dict[key[0]] = val[0];
		pos = val[1];
	}
	if (pos >= str.length) return null;
	return [dict, pos+1];
}

// is the given string numeric?
function isNum(str) {
	var i, c;
	str = str.toString();
	if(str.charAt(0) == '-')
		i = 1;
	else
		i = 0;

	for(; i < str.length; i++) {
		c = str.charCodeAt(i);
		if(c < 48 || c > 57) {
			return false;
		}
	}
	return true;
}

// returns the bencoding type of the given object
function btypeof(obj) {
	var type = typeof obj;
	if (type == "object") {
		if (obj instanceof Buffer) return "string";
		if (typeof obj.length == "undefined")
			return "dictionary";
		return "list";
	}
	return type;
}

// bencode a string
function bstring(str) {
	if (str instanceof Buffer) {
		var len = str.length;
		var slen = len.toString() + ":";
		var buf = new Buffer(slen.length + len);
		buf.write(slen, 0, 'utf8');
		str.copy(buf, slen.length, 0, len);
		return buf;
	} else {
		var len = Buffer.byteLength(str, 'utf8');
		var slen = len.toString() + ":";
		var buf = new Buffer(slen.length + len);
		buf.write(slen, 0, 'utf8');
		buf.write(str, slen.length, 'utf8');
		return buf;
	}
}

// bencode an integer
function bint(num) {
	return new Buffer("i" + num + "e", 'utf8');
}

// bencode a list
function blist(list) {
	var enclist = [];
	var buflen = 2, buf;
	for(key in list) {
		buf = bencode(list[key]);
		enclist.push(buf);
		buflen += buf.length;
	}

	buf = new Buffer(buflen);
	buf.write('l', 0, 'ascii');
	var i = 1;
	for(key in enclist) {
		var b = enclist[key];
		b.copy(buf, i, 0, b.length);
		i += b.length;
	}
	buf.write('e', i, 'ascii');
	return buf;
}

// bencode a dictionary
function bdict(dict) {
	var enclist = {};
	var buflen = 2, buf;

	for (var key in dict) {
		var bkey = bencode(key);
		var bval = bencode(dict[key]);
		buflen += bkey.length + bval.length;
		enclist[key] = [ bkey, bval ];
	}

	buf = new Buffer(buflen);
	buf.write('d', 0, 'ascii');
	var i = 1;
	var keylist = Object.keys(dict).sort();
	for (key in keylist) {
		var b = enclist[keylist[key]];
		b[0].copy(buf, i, 0, b[0].length);
		i += b[0].length;
		b[1].copy(buf, i, 0, b[1].length);
		i += b[1].length;
	}
	buf.write('e', i, 'ascii');
	return buf;
}
