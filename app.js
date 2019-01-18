
require('./logging');
const utils = require('./utils');

//================================================
// Configuration
//================================================

const config = require('./config.json');

if ( typeof(config.server_port) != 'number' || !config.server_port ) {
	config.server_port = config.server_https ? 443 : (env == 'production' ? 80 : 1337);
	console.warn("Missing or invalid 'server_port' in configuration - defaulting to " + config.server_port);
}

if ( typeof(config.bot_token) != 'string' || !config.bot_token )
	return console.error("Missing or invalid 'bot_token' in configuration");

if ( typeof(config.bot_prefix) != 'string' || !config.bot_prefix.trim() )
	return console.error("Missing or invalid 'bot_prefix' in configuration");
config.bot_prefix = config.bot_prefix.trim().toLowerCase() + " ";


//================================================
// Persisency
//================================================

const fs = require('fs');

const db = {
	file   : 'db.json',
	backup : 'db.json.bak',
	data   : {},
	save   : function() {
		try {
			fs.renameSync(db.file, db.backup);
		}
		catch(err) {
			if ( err.code != 'ENOENT' )
				return console.warn("Failed to backup db file:", err.message);
		}
		try {
			fs.writeFileSync(db.file, JSON.stringify(db.data, null, 2));
		}
		catch(err) {
			return console.warn("Failed to save db file:", err.message);
		}
		console.info("db saved");
	},
};
try {
	db.data = JSON.parse(fs.readFileSync(db.file));
}
catch(err) {
	console.warn("Failed to read db file:", err.message);
}

// Map hubName => { channelID => messageID }
db.data.Trackers || (db.data.Trackers = {});
console.info(Object.keys(db.data.Trackers).length + " trackers in db");


//================================================
// Server
//================================================

const express = require('express');
const server = express();

server.set('port', config.server_port);

// logger
server.use(require('morgan')('short', {
	skip: function(req, res) { return res.statusCode < 400 },
}));

// body parser
server.use(require('body-parser').json({
}));

// gzip
server.use(require('compression')({
}));

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

const Hubs = {};

const MATCH_FLAGS = {
	InProgress       : 0x0001,
	Ranked           : 0x0002,
	Private          : 0x0004,
	NoJoinInProgress : 0x0008,
	NoSpectators     : 0x0010,
	Beginner         : 0x0020,
};

function accessControl(req, res, perm) {
	var token = req.headers['x-api-token'];
	if ( !token ) {
		res.status(401).send({status:401, code:401, message:"Token required"});
		return null;
	}

	var user = config.server_keys ? config.server_keys[token] : null;
	if ( !user ) {
		res.status(401).send({status:401, code:401, message:"Invalid token"});
		return null;
	}

	if ( perm && (!user.perms || user.perms.indexOf('/'+perm+'/') == -1) ) {
		res.status(403).send({status:403, code:403, message:"Forbidden"});
		return null;
	}

	return user;
}

server.post('/hub/post', function(req, res) {
	if ( !accessControl(req, res, 'hubpost') )
		return;

	return Promise.resolve()
	.then(_ => {

		//debug
		console.debug(req.body);
		//console.debug(JSON.stringify(req.body,null,2));

		if ( typeof(req.body.ServerName) != 'string' || !req.body.ServerName )
			throw "invalid 'ServerName'";

		if ( Hubs[req.body.ServerName] && Date.now() - Hubs[req.body.ServerName].timestamp < 10000 )
			throw "too many updates";

		// validate used data to avoid crashes, just in case
		if ( typeof(req.body.Players) != 'object' || !req.body.Players.length ) req.body.Players = [];
		if ( typeof(req.body.Instances) != 'object' || !req.body.Instances.length ) req.body.Instances = [];
		req.body.ElapsedTime = Number(req.body.ElapsedTime);
		for ( var i of req.body.Instances ) {
			i.CustomGameName = String(i.CustomGameName);
			i.Flags = Number(i.Flags);
			i.RulesTitle = String(i.RulesTitle);
			i.MapName = String(i.MapName);
			i.NumPlayers = Number(i.NumPlayers);
			i.MaxPlayers = Number(i.MaxPlayers);
			i.InstanceLaunchTime = Number(i.InstanceLaunchTime);
		}

		req.body.timestamp = Date.now();
		Hubs[req.body.ServerName] = req.body;

		// Update trackers (asynchronously - errors here don't relate to the request)
		setTimeout(function() {
			updateTrackers(req.body.ServerName, formatHub(req.body));
		});

		return res.json({ status:'OK' });
	})
	.catch(err => {
		if ( typeof(err) == 'object' ) {
			console.warn("[Server] Hub post error:", err);
			res.status(500).send({status:500, code:500, message:"Internal Server Error"});
		}
		else
			res.status(400).send({status:400, code:400, message:err});
	});
});

// Error handling middleware
server.use(function errorMiddleware(err, req, res, next) {
	console.warn("[Server] Error caught in middleware:", err);
	if ( res.headersSent )
		next();
	else
		res.status(500).send({status:500, code:500, message:"Server Error"});
});

const ServerListener = server.listen(server.get('port'), function() {
	console.info("[Server] Running on port " + server.get('port'));
});


//================================================
// Bot
//================================================

const Discord = require('discord.js');
const bot = new Discord.Client();

bot.bOnline = false;

function login() {
	return bot.login(config.bot_token).then(_ => {
		console.info("[Bot] Ready");
		bot.bOnline = true;
	});
}

setTimeout(login);	// STARTUP

// Emitted when the client's WebSocket disconnects and will no longer attempt to reconnect.
bot.on('disconnect', code => {
	console.warn("[Bot] Disconnected:", code);
	bot.bOnline = false;
	utils.delayPromise(1000)
	.then(_ => utils.trySeveral(login, undefined, 100, 5000))
	.catch(err => console.error("[Bot] Failed to reconnect after 100 tries - giving up"));
});

// Emitted whenever the client's WebSocket encounters a connection error.
bot.on('error', function(err) {
	/*
	console.error("[Bot] Error:", err.message);
	bot.bOnline = false;
	utils.delayPromise(1000)
	.then(_ => utils.trySeveral(login, undefined, 100, 5000))
	.catch(err => console.error("[Bot] Failed to reconnect after 100 tries - giving up"));
	*/
});

bot.on('message', msg => {
	if ( msg.content.startsWith(config.bot_prefix) ) {
		if ( msg.channel.permissionsFor(msg.author).has("MANAGE_CHANNELS") || msg.author.id == config.superuser ) {
			var cmd = msg.content.substr(config.bot_prefix.length);
			processCommand(msg, cmd);
		}
	}
});

function processCommand(msg, cmd) {
	var action = cmd.trim().split(' ')[0];
	action || (action = "help");
	switch (action.toLowerCase()) {

		case 'help':
			reply(msg, "```markdown\n" + [
				"USAGE",
				"-----",
				config.bot_prefix + "list       : list all known hubs",
				config.bot_prefix + "add <hub>  : track hub in channel",
				config.bot_prefix + "rm  <hub>  : stop tracking hub in channel",
			].join('\n') + "```");
			break;

		case 'list':
			reply(msg, "```\n" + Object.keys(Hubs).map(name => ('"' + name + '"')).join("\n") + "```");
			break;

		case 'add':
			var name = cmd.substr(action.length+1);
			if ( name.startsWith('"') && name.endsWith('"') )
				name = name.slice(1,-1);
			if ( Hubs[name] ) {
				send(msg.channel.id, formatHub(Hubs[name]), true)
				.then(msg => {
					// add tracker
					db.data.Trackers[name] || (db.data.Trackers[name] = {});
					db.data.Trackers[name][msg.channel.id] = msg.id;
					db.save();
					// cache message object
					CachedTrackers[name] || (CachedTrackers[name] = {});
					CachedTrackers[name][msg.channel.id] = msg;
				})
				.catch(err => reply(msg, "An error occured"));
			}
			else
				reply(msg, 'Unknown hub "' + name + '"');
			break;

		case 'rm':
		case 'remove':
			var name = cmd.substr(action.length+1);
			if ( name.startsWith('"') && name.endsWith('"') )
				name = name.slice(1,-1);
			if ( db.data.Trackers[name] && db.data.Trackers[name][msg.channel.id] ) {

				// try to delete the message
				findMessage(name, msg.channel.id, db.data.Trackers[name][msg.channel.id])
				.then(msg => msg && msg.delete())
				.catch(err => console.warn("[Bot] Failed to fetch/delete message:", err));

				// remove from trackers
				delete db.data.Trackers[name][msg.channel.id];
				db.save();

				reply(msg, 'Removed tracker for "' + name + '"');
			}
			else
				reply(msg, 'Hub "' + name + '" is not being tracked here');
			break;

		case 'test':
			var name = cmd.substr(action.length+1);
			if ( name.startsWith('"') && name.endsWith('"') )
				name = name.slice(1,-1);
			if ( Hubs[name] )
				reply(msg, formatHub(Hubs[name]));
			else
				reply(msg, 'Unknown hub "' + name + '"');
			break;

		default:
			reply(msg, "Unknown command '" + cmd[0] + "'");
			break;
	}
}

function send(channelID, text, rethrow) {
	return Promise.resolve()
	.then(_ => {
		var channel = bot.channels.get(channelID);
		if ( !channel )
			throw new Error("Channel not found");

		return utils.trySeveral(trySendMessage, {
			chan : channel,
			text : text,
		}, 5, 1000);
	})
	.catch(err => {
		console.warn("[Bot] Failed to send message:", err.message);
		if ( rethrow )
			throw err;
	});
}

function reply(msg, text, rethrow) {
	return utils.trySeveral(trySendMessage, {
		chan : msg.channel,
		text : `${msg.author} » ${text}`,
	}, 5, 1000)
	.catch(err => {
		console.warn("[Bot] Failed to send message:", err.message);
		if ( rethrow )
			throw err;
	});
}

function trySendMessage(args) {
	//return utils.promisifyIn(args.chan, args.chan.send, args.text, {});
	return args.chan.send(args.text);
}

//NOTE: see bot.generateInvite(permissions)
function getInviteLink() {
	if ( typeof(config.bot_clientid) == 'string' && config.bot_clientid )
		return "https://discordapp.com/oauth2/authorize?&client_id=" + config.bot_clientid + "&scope=bot&permissions=2048";
	else
		return null;
}


//================================================
// Bridging
//================================================

// cache hubName => { channelID => message object }
// so we don't have to get channel and then fetch message all the time
var CachedTrackers = {};

function findMessage(hubName, channelID, messageID) {

	// already cached - use it directly
	if ( CachedTrackers[hubName] && CachedTrackers[hubName][channelID] )
		return Promise.resolve( CachedTrackers[hubName][channelID] );

	// get channel
	var chan = bot.channels.get(channelID);
	if ( !chan ) {
		console.warn("[Bot] Failed to get channel " + channelID);
		return Promise.resolve(null);
	}

	// fetch message
	return chan.fetchMessage(messageID)
	.then(msg => {
		// cache message
		CachedTrackers[hubName] || (CachedTrackers[hubName] = {});
		CachedTrackers[hubName][channelID] = msg;
		return msg;
	})
	.catch(err => {
		console.warn("[Bot] Failed to fetch message " + messageID);
		return null;
	});
}

// Edit all tracker messages for this hub
function updateTrackers(hubName, text) {
	if ( !bot.bOnline )
		return;

	// nothing to do
	if ( !db.data.Trackers[hubName] || db.data.Trackers[hubName].length == 0 )
		return;

	// find the messages to edit
	var promises = [];
	for ( var channelID in db.data.Trackers[hubName] )
		promises.push( findMessage(hubName, channelID, db.data.Trackers[hubName][channelID]) );

	return Promise.all(promises)
	.then(messages => messages.filter(msg => !!msg).map(msg =>
		msg.edit(text)
		.then(msg => {
			// update cache (not sure if necessary)
			CachedTrackers[hubName][msg.channel.id] = msg;
		})
		.catch(err => console.warn("[Bot] Failed to edit message:", err))
	));
}

setInterval(function trackOfflineHubs() {
	if ( !bot.bOnline )
		return;

	for ( var hubName in db.data.Trackers ) {
		var text;
		if ( !Hubs[hubName] )
			text = "No data received.";
		else if ( Date.now() - Hubs[hubName].timestamp >= 65000 )
			text = "No data received since " + formatSince(Hubs[hubName].timestamp);
		else
			continue;

		text = "```markdown\n" + hubName + "\n" + utils.repeatStr('-', hubName.length) + "\n" + text + "\n```";

		updateTrackers(hubName, text);
	}
}, 60000);

function formatSince(ts) {
	var seconds = Math.round( (Date.now() - ts) / 1000 );
	return Math.floor(seconds/3600) + "h" + ("0"+Math.floor((seconds%3600)/60)).slice(-2) + "m";
}

// Format hub message (if alive)
function formatHub(hub) {

	// case where hub exists but is stale (might be called from the ADD command)
	if ( Date.now() - hub.timestamp >= 65000 )
		return "```markdown\n" + hub.ServerName + "\n" + utils.repeatStr('-', hub.ServerName.length) + "\n" + "No data received since " + formatSince(hub.timestamp) + "\n```";

	var lines = [
		"```markdown",
		hub.ServerName,
	];

	var numPlayers = utils.plural(hub.Players.length," player");
	var numMatches = utils.plural(hub.Instances.length," match"," matches");
	var len = Math.max(hub.ServerName.length, numPlayers.length+4+numMatches.length);
	lines.push( utils.repeatStr('-', len) );
	lines.push( numPlayers + utils.padAlignRight(numMatches, len-numPlayers.length) );

	lines.push("");

	lines.push(
		utils.padAlignLeft("Instance",20)
		+ utils.padAlignLeft("Game",20)
		+ utils.padAlignLeft("Map",14)
		+ utils.padAlignLeft("Players",9)
		+ utils.padAlignRight("Alive",6)
	);

	lines.push( utils.repeatStr('-', lines[5].length) );

	for ( var instance of hub.Instances ) {

		var name = instance.CustomGameName;
		if ( instance.Flags & MATCH_FLAGS.Private )
			name = "🔒" + name;

		var game = instance.RulesTitle;
		if ( game.startsWith('Custom ') )
			game = '*'+game.substr(7);

		lines.push(
			utils.padAlignLeft(utils.truncate(name,18),20)
			+ utils.padAlignLeft(utils.truncate(game,18),20)
			+ utils.padAlignLeft(utils.truncate(instance.MapName,12),14)
			+ utils.padAlignLeft(instance.NumPlayers + " / " + instance.MaxPlayers,9)
			+ utils.padAlignRight(formatAlive(hub.ElapsedTime - instance.InstanceLaunchTime), 6)
		);
	}

	lines.push("```");
	return lines.join("\n");
}

function formatAlive(seconds) {
	seconds = Math.round(Math.max(0,seconds));
	return Math.floor(seconds/3600) + "h" + ("0"+Math.floor((seconds%3600)/60)).slice(-2) + "m";
}


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
