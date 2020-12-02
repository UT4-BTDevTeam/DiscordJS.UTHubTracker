

const logger = require('./logger');
const utils = require('./utils');

//================================================
// Configuration
//================================================

const config = require('./config.json');

if ( typeof(config.server_port) != 'number' || !config.server_port ) {
	config.server_port = 1337;
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

	// merge calls, save next tick
	save: function() {
		if ( db.saveTimeout )
			return;
		db.saveTimeout = setTimeout(function() {
			delete db.saveTimeout;
			db.__save();
		});
	},

	__save: function() {
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

// Map hubName => { channelID : messageID }
db.data.Trackers || (db.data.Trackers = {});
console.info( Object.keys(db.data.Trackers).reduce((acc,hubName) => acc+Object.keys(db.data.Trackers[hubName]).length, 0) + " trackers in db");


//================================================
// Server
//================================================

const express = require('express');
const server = express();

// logger
const onFinished = require('on-finished');
server.use(function(req, res, next) {
	req.headers || (req.headers = []);
	// log error responses
	onFinished(res, function() {
		if ( res.statusCode >= 400 ) {
			console.custom(res.statusCode, (res.statusCode < 500) ? logger.YELLOW : logger.RED,
				req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || req._remoteAddress || (req.connection && req.connection.remoteAddress) || '?',
				req.method || '?',
				req.url
			);
		}
	});
	// log api requests
	if ( logger.debug ) {
		console.custom('req', logger.CYAN,
			req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || req._remoteAddress || (req.connection && req.connection.remoteAddress) || '?',
			req.method || '?',
			req.url
		);
	}
	return next();
});

// body parser
server.use(require('body-parser').json({
}));

// gzip
server.use(require('compression')({
}));

// favicon
server.use(require('serve-favicon')(__dirname + '/favicon.jpg'));

server.on('error', function onError(err) {
	if ( err.syscall !== 'listen' )
		throw err;
	switch ( err.code ) {
		case 'EACCES':
			console.error("[Server] Port " + config.server_port + " requires elevated privileges");
			process.exit(1);
			break;
		case 'EADDRINUSE':
			console.error("[Server] Port " + config.server_port + " is already in use");
			process.exit(1);
			break;
		default:
			throw err;
	}
});

// Map hubName => {hubData}
const Hubs = {};

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

// Entry point for HUB plugin (UTHubAdvertiser)
server.post('/hub/post', function(req, res) {
	if ( !accessControl(req, res, 'hubpost') )
		return;

	return Promise.resolve()
	.then(_ => {

		//debug
		console.debug(req.body);
		//console.debug(JSON.stringify(req.body,null,2));

		if ( typeof(req.body.ServerName) != 'string' )
			throw "invalid 'ServerName'";

		var hubName = sanitizeForDiscordBlock(req.body.ServerName);
		if ( !hubName )
			throw "invalid 'ServerName'";

		if ( Hubs[hubName] && Date.now() - Hubs[hubName].timestamp < 10000 )
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
			if ( typeof(i.Players) != 'object' || !i.Players.length ) i.Players = [];
			for ( var p of i.Players ) {
				p.PlayerName = String(p.PlayerName);
			}
		}

		req.body.timestamp = Date.now();

		if ( !Hubs[hubName] )
			console.info('Registering new Hub "' + hubName + '"');

		Hubs[hubName] = req.body;

		// Update trackers (asynchronously - errors here don't relate to the request)
		setTimeout(function() {
			updateTrackers(hubName, formatHub(req.body));
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

// Public API : Get all current active hubs
server.get(['/hubs', '/hubs/:schema'], function(req, res) {
	var schema = (req.params.schema || "").split('+');

	var data = {}, hub, output, keyPath;
	for ( var name in Hubs ) {
		hub = Hubs[name];
		if ( !hub.stale ) {
			output = {};
			for ( keyPath of schema )
				includeKeyPath(hub, keyPath, output);
			data[name] = output;
		}
	}

	res.status(200).send({ status:'OK', data:data });
});

function includeKeyPath(inObj, keyPath, outObj) {
	if ( !inObj || !outObj )
		return;

	if ( typeof(keyPath) == 'string' )
		keyPath = keyPath.split('.');

	if ( keyPath.length == 1 ) {
		// if array of objects, include an array of empty subobjects
		// if array of values, include as is
		if ( typeof(inObj[keyPath]) == 'object' && inObj[keyPath] ) {
			outObj[keyPath] = inObj[keyPath].map(elem => {
				if ( typeof(elem) == 'object' && elem )
					return {};
				else
					return elem;
			});
		}
		// if value, copy as is
		else
			outObj[keyPath] = inObj[keyPath];
	}
	else {
		inObj = inObj[keyPath[0]];
		outObj = outObj[keyPath[0]];
		// if keys are properly set in right order, outObj array should be prepared with empty subobjects
		if ( inObj && inObj.length && outObj && outObj.length ) {
			for ( var i=0; i<inObj.length; i++ ) {
				// recurse on array subobjects
				includeKeyPath(inObj[i], keyPath.slice(1), outObj[i]);
			}
		}
	}
}

server.get('/weblist', function(req, res) {
	var html = "<!DOCTYPE HTML>";
	html += "<head></head>";
	html += "<style>table,th,td{border:1px solid #333;}table{border-collapse:collapse;}th,td{padding:2px 4px;}</style>";
	html += "<body style='background-color:#333'>";
	for ( var name in Hubs ) {
                hub = Hubs[name];
                if ( !hub.stale ) {
			html += "<div style='background-color:#fafafa;margin:1em;padding:0.5em'><h3 style='margin:0 0 0.5em 0'>" + hub.ServerName + "</h3>";
			html += "<table><thead><tr><th>Instance</th><th>Game</th><th>Map</th><th>Players</th><th>Since</th></thead><tbody>";
			for ( var instance of hub.Instances ) {
				html += "<tr><td>";
				if ( instance.Flags & MATCH_FLAGS.Private )
					html += "🔒"
				html += instance.CustomGameName + "</td><td>"
				var game = instance.RulesTitle;
				if ( game.startsWith('Custom ') )
					game = '*'+game.substr(7);
				html += game + "</td><td>" + instance.MapName + "</td><td>" + instance.NumPlayers + " / " + instance.MaxPlayers + "</td><td>" + formatAlive(hub.RealTimeSeconds - instance.InstanceLaunchTime) + "</td></tr>";
			}
			html += "</tbody></table></div>";
                }
        }
	html += "</body>";
	res.set('Content-Type', 'text/html');
	res.send(html);
});

// Final catchall route for 404
server.all('*', function(req, res) {
	res.status(404).send({status:404, code:404, message:"Not Found"});
});

// Error handling middleware
server.use(function errorMiddleware(err, req, res, next) {
	console.warn("[Server] Error caught in middleware:", err);
	if ( res.headersSent )
		next();
	else
		res.status(500).send({status:500, code:500, message:"Internal Server Error"});
});

const ServerListener = server.listen(config.server_port, function() {
	console.info("[Server] Running on port " + config.server_port);
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

//STARTUP
setTimeout(function main() {
	utils.trySeveral(login, undefined, 3, 3000)
	.catch(err => {
		console.error("[Bot] Initial login failed:", err.message);
		process.exit(1);
	});
});

// Emitted when the client's WebSocket disconnects and will no longer attempt to reconnect.
bot.on('disconnect', code => {
	console.warn("[Bot] Disconnected:", code);
	bot.bOnline = false;
	utils.delayPromise(1000)
	.then(_ => utils.trySeveral(login, undefined, 100, 5000))
	.catch(err => console.error("[Bot] Failed to reconnect after 100 tries - giving up:", err.message));
});

// Emitted whenever the client's WebSocket encounters a connection error.
bot.on('error', function(err) {
	console.warn("[Bot] Error:", err.message);
/*
	bot.bOnline = false;
	utils.delayPromise(1000)
	.then(_ => utils.trySeveral(login, undefined, 100, 5000))
	.catch(err => console.error("[Bot] Failed to reconnect after 100 tries - giving up"));
*/
});

bot.on('message', msg => {
	if ( msg.content.toLowerCase().startsWith(config.bot_prefix) && msg.channel && typeof(msg.channel.permissionsFor) == 'function' ) {
		if ( msg.channel.permissionsFor(msg.author).has("MANAGE_CHANNELS") || msg.author.id == config.bot_superuser ) {
			var cmd = msg.content.substr(config.bot_prefix.length);
			processCommand(msg, cmd);
		}
		else
			reply(msg, "You do not have enough permissions to configure this bot");
	}
});

function processCommand(msg, cmd) {
	var action = cmd.trim().split(' ')[0].toLowerCase() || "help";
	switch (action) {

		case 'help':
			reply(msg, "```markdown\n" + [
				"USAGE",
				"-----",
				config.bot_prefix + "list       : list all known hubs",
				config.bot_prefix + "add <hub>  : track hub in channel",
				config.bot_prefix + "rm  <hub>  : stop tracking hub in channel",
				config.bot_prefix + "edit <old> <new>  : edit a tracker in-place (quotes required)",
				config.bot_prefix + "cleanup    : delete bot messages that are not active trackers",
			].join('\n') + "```");
			break;

		case 'available':
		case 'list':
			reply(msg, "```\n" + Object.keys(Hubs).map(name => ('"' + name + '"')).join("\n") + "```");
			break;

		case 'add':
			var name = cmd.substr(action.length+1).trim();
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
			var name = cmd.substr(action.length+1).trim();
			if ( name.startsWith('"') && name.endsWith('"') )
				name = name.slice(1,-1);
			if ( db.data.Trackers[name] && db.data.Trackers[name][msg.channel.id] ) {

				// try to delete the message
				findMessage(name, msg.channel.id, db.data.Trackers[name][msg.channel.id])
				.then(msg => msg && msg.delete())
				.catch(err => console.warn("[Bot] Failed to fetch/delete message:", err.message));

				// remove from trackers
				removeTracker(name, msg.channel.id);

				reply(msg, 'Removed tracker for "' + name + '"');
			}
			else
				reply(msg, 'Hub "' + name + '" is not being tracked here');
			break;

		case 'rename':
		case 'edit':
			var args = cmd.substr(action.length+1).trim();
			var m = args.match(/^"([^"]+)"\s*"([^"]+)"$/);
			if ( !m ) {
				reply(msg, 'Usage is ` edit "old" "new" ` (quotes required)');
				break;
			}
			var oldName = m[1];
			if ( !db.data.Trackers[oldName] || !db.data.Trackers[oldName][msg.channel.id] ) {
				reply(msg, 'Tracker for "' + oldName + '" not found in this channel');
				break;
			}
			var newName = m[2];
			if ( newName == oldName ) {
				reply(msg, "meh");
				break;
			}
			if ( !Hubs[newName] ) {
				reply(msg, 'Unknown hub "' + newName + '"');
				break;
			}

			// copy tracker entry
			db.data.Trackers[newName] || (db.data.Trackers[newName] = {});
			db.data.Trackers[newName][msg.channel.id] = db.data.Trackers[oldName][msg.channel.id];

			// copy cache entry
			if ( CachedTrackers[oldName] ) {
				CachedTrackers[newName] || (CachedTrackers[newName] = {});
				CachedTrackers[newName][msg.channel.id] = CachedTrackers[oldName][msg.channel.id];
			}

			// remove old tracker entry
			removeTracker(oldName, msg.channel.id);

			reply(msg, 'Successfully edited tracker "' + oldName + '" to "' + newName + '"');
			break;

		case 'cleanup':
		case 'purge':
			// get active trackers in channel (message ID is enough)
			var activeTrackers = {};
			for ( var hub in db.data.Trackers ) {
				if ( db.data.Trackers[hub][msg.channel.id] )
					activeTrackers[ db.data.Trackers[hub][msg.channel.id] ] = 1;
			}

			// get messages in channel
			msg.channel.fetchMessages({ limit: 20 })
			// only bot messages and exclude active trackers
			.then(messages => messages.filter(msg => (msg.author.id == bot.user.id && !activeTrackers[msg.id])))
			// bulk delete
			//.then(messages => msg.channel.bulkDelete(messages))
			.then(messages => messages.forEach(msg => msg.delete()))
			.catch(err => {
				console.warn("[Bot] Cleanup failed:", err.code, err.message);
				reply(msg, "An error occured");
			});
			break;

		case 'test':
			var name = cmd.substr(action.length+1).trim();
			if ( name.startsWith('"') && name.endsWith('"') )
				name = name.slice(1,-1);
			if ( Hubs[name] )
				reply(msg, formatHub(Hubs[name]));
			else
				reply(msg, 'Unknown hub "' + name + '"');
			break;

		case 'invite':
			if ( msg.author.id == config.bot_superuser ) {
				bot.generateInvite(2048)
				.then(invite => reply(msg, "<"+invite+">"))
				.catch(err => {
					console.warn("[Bot] Invite failed:", err.code, err.message);
					reply(msg, "An error occured");
				});
			}
			break;

		default:
			reply(msg, "Unknown command '" + action + "'");
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

const MATCH_FLAGS = {
	InProgress       : 0x0001,
	Ranked           : 0x0002,
	Private          : 0x0004,
	NoJoinInProgress : 0x0008,
	NoSpectators     : 0x0010,
	Beginner         : 0x0020,
};

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
		console.warn("[Bot] Failed to fetch message " + messageID + ":", err.code, err.message);
		if ( err.code == 10008 ) {
			// message has most likely been deleted - remove tracker
			if ( db.data.Trackers[hubName] && db.data.Trackers[hubName][channelID] == messageID )
				removeTracker(hubName, channelID);
		}
		return null;
	});
}

function removeTracker(hubName, channelID) {
	if ( CachedTrackers[hubName] )
		delete CachedTrackers[hubName][channelID];

	delete db.data.Trackers[hubName][channelID];
	if ( Object.keys(db.data.Trackers[hubName]).length == 0 )
		delete db.data.Trackers[hubName];

	db.save();
}

// Edit all tracker messages for this hub
function updateTrackers(hubName, text) {
	if ( !bot.bOnline )
		return;

	// nothing to do
	if ( !db.data.Trackers[hubName] || Object.keys(db.data.Trackers[hubName]).length == 0 )
		return;

	// find the messages to edit
	var promises = [];
	for ( var channelID in db.data.Trackers[hubName] )
		promises.push( findMessage(hubName, channelID, db.data.Trackers[hubName][channelID]) );

	return Promise.all(promises)
	.then(messages => messages.filter(msg => !!msg).map(msg =>
		msg.edit(text)
		/*
		.then(msg => {
			// update cache (not sure if necessary)
			CachedTrackers[hubName][msg.channel.id] = msg;
		})
		*/
		.catch(err => {
			console.warn("[Bot] Failed to edit message " + msg.id + ":", err.code, err.message);
			if ( err.code == 10008 ) {
				// cached message was deleted - remove cache & tracker
				removeTracker(hubName, channelID);
			}
		})
	));
}

setInterval(function trackOfflineHubs() {
	if ( !bot.bOnline )
		return;

	for ( var hubName in db.data.Trackers ) {
		var text;
		if ( !Hubs[hubName] )
			text = "No data received.";
		else if ( Date.now() - Hubs[hubName].timestamp >= 65000 ) {
			Hubs[hubName].stale = true;
			text = "No data received since " + formatSince(Hubs[hubName].timestamp);
		}
		else
			continue;

		var sanitized = sanitizeForDiscordBlock(hubName);
		text = "`"+formatDateTime()+"` ```markdown\n" + sanitized + "\n" + utils.repeatStr('-', sanitized.length) + "\n" + text + "```";

		updateTrackers(hubName, text);
	}
}, 60000);

function formatSince(ts) {
	var seconds = Math.round( (Date.now() - ts) / 1000 );
	return Math.floor(seconds/3600) + "h" + ("0"+Math.floor((seconds%3600)/60)).slice(-2) + "m";
}

// Format hub message (if alive)
function formatHub(hub) {

	var hubName = sanitizeForDiscordBlock(hub.ServerName);

	// case where hub exists but is stale (might be called from the ADD command)
	if ( hub.stale )
		return "`"+formatDateTime()+"` ```markdown\n" + hubName + "\n" + utils.repeatStr('-', hubName.length) + "\nNo data received since " + formatSince(hub.timestamp) + "```";

	var lines = [
		"`"+formatDateTime()+"` ```markdown",
		hubName,
	];

	var numPlayers = hub.Players.length + hub.Instances.reduce((acc,inst) => acc+inst.NumPlayers, 0);
	numPlayers = utils.plural(numPlayers," player");
	var numMatches = utils.plural(hub.Instances.length," match"," matches");
	var len = Math.max(lines[1].length, numPlayers.length+4+numMatches.length);
	lines.push( utils.repeatStr('-', len) );
	lines.push( numPlayers + utils.padAlignRight(numMatches, len-numPlayers.length) );

	lines.push("");

	lines.push(
		utils.padAlignLeft("Instance",20)
		+ utils.padAlignLeft("Game",20)
		+ utils.padAlignLeft("Map",14)
		+ utils.padAlignLeft("Players",9)
		+ utils.padAlignRight("Since",6)
	);

	lines.push( utils.repeatStr('-', lines[5].length) );

	var separatorLines = [];

	for ( var instance of hub.Instances ) {

		var name = sanitizeForDiscordBlock(instance.CustomGameName);
		if ( instance.Flags & MATCH_FLAGS.Private )
			name = "🔒" + name;

		var game = instance.RulesTitle;
		if ( game.startsWith('Custom ') )
			game = '*'+game.substr(7);

		var slots = instance.NumPlayers + " / " + instance.MaxPlayers;
		if ( slots.length <= 6 )	// center the slash
			slots = " " + slots;

		lines.push(
			utils.padAlignLeft(utils.truncate(name,18),20)
			+ utils.padAlignLeft(utils.truncate(game,18),20)
			+ utils.padAlignLeft(utils.truncate(sanitizeForDiscordBlock(instance.MapName),12),14)
			+ utils.padAlignLeft(slots,9)
			+ utils.padAlignRight(formatAlive(hub.RealTimeSeconds - instance.InstanceLaunchTime), 6)
		);

		// experimental: show players on second line
		lines.push("> " + instance.Players.map(p => sanitizeForDiscordBlock(p.PlayerName).substr(0,10)).join(" "));
		// + separator
		separatorLines.push(lines.length);
		lines.push("#" + utils.repeatStr('-', lines[5].length-2) + "#");
	}

	lines.push("```");
	var msg = lines.join("\n");

	// remove lengthy separators if above 2000 chars
	if ( msg.length > 1900 ) {
		for ( var i of separatorLines )
			lines[i] = "";
		msg = lines.join("\n");
	}

	return msg;
}

function formatDateTime() {
	var d = new Date();
	return ('0'+d.getDate()).slice(-2)+'/'+('0'+(d.getMonth()+1)).slice(-2)+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
}

function formatAlive(seconds) {
	seconds = Math.round(Math.max(0,seconds));
	return Math.floor(seconds/3600) + "h" + ("0"+Math.floor((seconds%3600)/60)).slice(-2) + "m";
}

function sanitizeForDiscordBlock(str) {
	return str.replace(/`/g, "'").replace(/[\n\r\t]/g, " ").replace(/_/g, "-").replace(/#/g, "♯").trim();
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

