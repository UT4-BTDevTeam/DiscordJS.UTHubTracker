
var C = {
	BLACK :"", RED    :"", GREEN:"", YELLOW:"",
	BLUE  :"", MAGENTA:"", CYAN :"", WHITE :"",
	NORMAL:"", GRAY   :"",
};

if ( process.argv.indexOf('-nocolor') == -1 && process.argv.indexOf('-nocolors') == -1 ) {
	C = {
		BLACK :"\x1b[30m", RED    :"\x1b[31m", GREEN:"\x1b[32m", YELLOW:"\x1b[33m",
		BLUE  :"\x1b[34m", MAGENTA:"\x1b[35m", CYAN :"\x1b[36m", WHITE :"\x1b[37m",
		NORMAL:"\x1b[39m", GRAY   :"\x1b[90m",
	};
}

console.ts = function() {
	var d = new Date();
	return C.GRAY + d.toISOString().substr(5,5).replace('-','/') + " " + d.toISOString().substr(11,8) + " |" + C.NORMAL + " ";
}

console._log = console.log;

console.log = function() { process.stdout.write(console.ts() + C.GRAY + "log:" + C.NORMAL + " "); console._log.apply(null, arguments); }

console.main  = function() { process.stdout.write(console.ts() + C.MAGENTA + ">>>>"   + C.NORMAL + " "); console._log.apply(null, arguments) }

console.info  = function() { process.stdout.write(console.ts() + C.GREEN   + "info:"  + C.NORMAL + " "); console._log.apply(null, arguments) }

console.warn  = function() { process.stdout.write(console.ts() + C.YELLOW  + "warn:"  + C.NORMAL + " "); console._log.apply(null, arguments) }

console.error = function() { process.stdout.write(console.ts() + C.RED     + "error:" + C.NORMAL + " "); console._log.apply(null, arguments) }

console.debug = function() {}

console.setDebug = function(b) {
	b || console.debug("Debug disabled");
	console.debug = b ? function() { process.stdout.write(console.ts() + C.GRAY + "debug:" + C.NORMAL + " "); console._log.apply(null, arguments); } : function(){}
	b && console.debug("Debug enabled");
}

if ( process.argv.indexOf('-d') >= 0 || process.argv.indexOf('--debug') >= 0 )
	console.setDebug(true);
