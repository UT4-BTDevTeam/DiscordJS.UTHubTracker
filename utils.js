
exports.padnum = function(n, len) {
	return ("00000000" + n).substr(-len, len);
}

exports.repeatStr = function(c, len) {
	var res = "";
	for ( var i=0; i<len; i++ )
		res += c;
	return res;
}

exports.truncate = function(str, len) {
	if ( str && str.length > len ) return str.substring(0, len-1) + "…";
	return str;
}

exports.plural = function(count, singular, plural) {
	return count + ( (count == 1) ? singular : (plural || (singular+'s')) );
}

exports.randomItem = function(array) {
	return array[Math.floor(Math.random()*array.length)];
}

exports.padAlignLeft = function(str, n) {
	var res = String(str).substr(0,n);
	while ( res.length < n )
		res += ' ';
	return res;
}

exports.padAlignRight = function(str, n) {
	var res = String(str).substr(0,n);
	while ( res.length < n )
		res = ' ' + res;
	return res;
}

exports.promisify = function(func /*...args*/) {
	var args = [];
	for ( var i=1; i<arguments.length; i++ )
		args.push(arguments[i]);
	return new Promise(function(resolve, reject) {
		args.push(function(err, res) {
			if ( err )
				reject(err);
			else
				resolve(res);
		});
		func.apply(null, args);
	});
}

exports.promisifyIn = function(obj, func /*...args*/) {
	if ( typeof(func) != 'function' )
		func = obj[func];

	var args = [];
	for ( var i=2; i<arguments.length; i++ )
		args.push(arguments[i]);
	return new Promise(function(resolve, reject) {
		args.push(function(err, res) {
			if ( err )
				reject(err);
			else
				resolve(res);
		});
		func.apply(obj, args);
	});
}

exports.delayPromise = function(delay) {
	return new Promise(function(resolve, reject) {
		setTimeout(resolve, delay);
	});
}

exports.trySeveral = function(func, args, maxAttemps, interval) {
	if ( maxAttemps <= 1 )
		return func(args);

	return func(args).catch(function(err) {
		return exports.delayPromise(interval)
		.then(function() {
			return exports.trySeveral(func, args, maxAttemps-1, interval);
		});
	});
}
