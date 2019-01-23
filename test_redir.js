//================================================
// Server
//================================================

const express = require('express');
const server = express();

server.on('error', function onError(err) {
	if ( err.syscall !== 'listen' )
		throw err;
	switch ( err.code ) {
		case 'EACCES':
			console.error("[Server] Port " + server.get('port') + " requires elevated privileges");
			process.exit(1);
			break;
		case 'EADDRINUSE':
			console.error("[Server] Port " + server.get('port') + " is already in use");
			process.exit(1);
			break;
		default:
			throw err;
	}
});

server.post('/hub/post', function(req, res) {
	console.log("REQ");
	return res.redirect('http://localhost:56000/hub/post');
});

const ServerListener = server.listen(10000, function() {
	console.info("[Server] Running on port 10000");
});


//================================
// Fatal / Exiting
//================================

process.on('uncaughtException', function(err) {
	console.error("!! Uncaught exception !");
	console.error(err);
	process.exit(1);
});

process.on('SIGINT', function() {
	console.warn("Received SIGINT !");
	process.exit(2);
});

process.on('exit', function(code) {
	process.emit('cleanup');
	console.info("Exiting with code " + code + "...");
});

process.on('cleanup', function(args) {
	console.info("Cleaning up...");
	// nothing to do
});
