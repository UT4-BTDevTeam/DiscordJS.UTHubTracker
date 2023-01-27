

const logger = require('./logger');
const utils = require('./utils');

//================================================
// Configuration
//================================================

const config = require('./config.json');

if ( typeof(config.bot_token) != 'string' || !config.bot_token )
	return console.error("Missing or invalid 'bot_token' in configuration");

if ( typeof(config.bot_prefix) != 'string' || !config.bot_prefix.trim() )
	return console.error("Missing or invalid 'bot_prefix' in configuration");
config.bot_prefix = config.bot_prefix.trim().toLowerCase() + " ";


//================================================
// Persistency
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
// Poller
//================================================

const fetch = require('node-fetch');

// Map hubName => {hubData}
const Hubs = {};

const POLL_INTERVAL = 60000;
const POLL_ERROR_INTERVAL = 60000;

var playersMap = {};

async function poller() {
	var serverData = null;
	try {
		const res = await fetch("https://master-ut4.timiimit.com/ut/api/matchmaking/session/matchMakingRequest");
		serverData = await res.json();
	}
	catch(err) {
		console.error(err);
		return setTimeout(poller, POLL_ERROR_INTERVAL);
	}

	// Initial fetch
	if (Object.keys(playersMap).length == 0)
		await refreshPlayersMap();

	const hubGuidMap = {};
	const hubsToUpdate = [];

	// Gather hubs into Hubs
	for (let hubData of serverData.filter(item => item.attributes.UT_GAMEINSTANCE_i == 0)) {
		let hubName = hubData.attributes.UT_SERVERNAME_s.trim();
		hubData.hubName = hubName;
		hubData.Instances = [];
		hubData.timestamp = Date.now();

		if (!Hubs[hubName])
			console.info('Registering new Hub "' + hubName + '"');

		Hubs[hubName] = hubData;

		hubGuidMap[hubData.attributes.UT_HUBGUID_s] = hubData;

		if (db.data.Trackers[hubName] && Object.keys(db.data.Trackers[hubName]).length > 0)
			hubsToUpdate.push(hubData);
	}

	// Gather instances into hubs
	for (let instanceData of serverData.filter(item => item.attributes.UT_GAMEINSTANCE_i == 1)) {
		let hub = hubGuidMap[instanceData.attributes.UT_HUBGUID_s];
		if (hub)
			hub.Instances.push(instanceData);
	}

	// Resolve players
	for (let hub of hubsToUpdate) {
		for (let instance of hub.Instances) {
			for (let i=0; i<instance.publicPlayers.length; i++) {
				if (playersMap[instance.publicPlayers[i]] === undefined)
					await refreshPlayersMap();
				instance.publicPlayers[i] = playersMap[instance.publicPlayers[i]] || "???";
			}
		}
	}

	let ts = Date.now();
	for (let hub of hubsToUpdate) {
		try {
			updateTrackers(hub.hubName, formatHub(hub));
		}
		catch(err) { console.error(err); }
		// Try to schedule discord updates overtime
		await utils.delayPromise(0.80 * POLL_INTERVAL / hubsToUpdate.length);
	}
	let timeSpentUpdating = Date.now() - ts;

	setTimeout(poller, Math.max(1, POLL_INTERVAL-timeSpentUpdating));
}

var playersMapLastRefresh = 0;	//avoid trying to refresh multiple times in the same cycle
var authToken = null;

async function refreshPlayersMap() {
	if (playersMapLastRefresh > (Date.now() - 5000))
		return;
	playersMapLastRefresh = Date.now();

	if (!await ensureAuthToken())
		return;

	try {
		const res = await fetch("https://master-ut4.timiimit.com/account/api/public/accounts", {
			headers: {
				Authorization: 'Bearer ' + authToken.access_token,
			}
		});
		if (res.status >= 400)
			throw new Error(`Request failed: ${res.status} ${res.statusText}`);

		const textData = await res.text();
		try {
			const data = JSON.parse(textData);
			if (data && data.length) {
				console.info("Registering " + data.length + " players");
				for (let entry of data)
					playersMap[entry.id] = entry.displayName;
			}
		}
		catch(err) {
			throw new Error(`JSON parse error: ${textData}`);
		}
	}
	catch(err) {
		console.error(err);
	}
}

async function ensureAuthToken() {
	if (!authToken || authToken.expires_at < new Date(Date.now() - 10000).toISOString())
		await refreshAuthToken();

	return (authToken != null);
}

var authTokenLastRefresh = 0;	//avoid trying to refresh multiple times in the same cycle

async function refreshAuthToken() {
	if (authTokenLastRefresh > (Date.now() - 5000))
		return;
	authTokenLastRefresh = Date.now();

	try {
		const res = await fetch('https://master-ut4.timiimit.com/account/api/oauth/token', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				// Using GameInstance hardcoded login
				'Authorization': "Basic NmZmNDNlNzQzZWRjNGQxZGJhYzM1OTQ4NzdiNGJlZDk6NTQ2MTlkNmY4NGQ0NDNlMTk1MjAwYjU0YWI2NDlhNTM="
			},
			body: 'grant_type=client_credentials'
		});
		authToken = await res.json();
		console.info("Token renewed until " + authToken.expires_at);
	}
	catch(err) {
		console.error(err);
		authToken = null;
	}
}


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
		setTimeout(poller);
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
			msg.channel.messages.fetch({ limit: 20 })
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
		var channel = bot.channels.cache.get(channelID);
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
	var chan = bot.channels.cache.get(channelID);
	if ( !chan ) {
		console.warn("[Bot] Failed to get channel " + channelID);
		return Promise.resolve(null);
	}

	// fetch message
	return chan.messages.fetch(messageID)
	.then(msg => {
		// cache message
		CachedTrackers[hubName] || (CachedTrackers[hubName] = {});
		CachedTrackers[hubName][channelID] = msg;
		return msg;
	})
	.catch(err => {
		console.warn("[Bot] Failed to fetch message " + messageID + ":", err.code, err.message);
		if ( err.code == 10008 || err.code == 10003 ) {
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

	var hubName = sanitizeForDiscordBlock(hub.attributes.UT_SERVERNAME_s);

	// case where hub exists but is stale (might be called from the ADD command)
	if ( hub.stale )
		return "`"+formatDateTime()+"` ```markdown\n" + hubName + "\n" + utils.repeatStr('-', hubName.length) + "\nNo data received since " + formatSince(hub.timestamp) + "```";

	var lines = [
		"`"+formatDateTime()+"` ```markdown",
		hubName,
	];

	var numPlayers = hub.totalPlayers + hub.Instances.reduce((acc,inst) => acc+inst.totalPlayers, 0);
	numPlayers = utils.plural(numPlayers," player");
	var numMatches = utils.plural(hub.Instances.length," match"," matches");
	var len = Math.max(lines[1].length, numPlayers.length+4+numMatches.length);
	lines.push( utils.repeatStr('-', len) );
	lines.push( numPlayers + utils.padAlignRight(numMatches, len-numPlayers.length) );

	lines.push("");

	lines.push(
		utils.padAlignLeft("Instance", 60)
		+ utils.padAlignRight("Players", 9)
	);

	lines.push( utils.repeatStr('-', lines[5].length) );

	var separatorLines = [];

	for (let instance of hub.Instances) {

		var name = sanitizeForDiscordBlock(instance.attributes.UT_SERVERNAME_s);

		// not sure if still applicable
		if (name.startsWith('Custom '))
			name = '*'+name.substr(7);

		// not sure if this is the right flags
		if (instance.attributes.UT_SERVERFLAGS_i & MATCH_FLAGS.Private)
			name = "🔒" + name;
		

		var slots = instance.attributes.UT_PLAYERONLINE_i + " / " + instance.attributes.UT_MAXPLAYERS_i;
		if (slots.length <= 6)	// center the slash
			slots = " " + slots;

		lines.push(
			utils.padAlignLeft(utils.truncate(name,58),60)
			+ utils.padAlignRight(slots,9)
		);

		// experimental: show players on second line
		lines.push("> " + instance.publicPlayers.map(p => sanitizeForDiscordBlock(p).substr(0,10)).join(" "));
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

