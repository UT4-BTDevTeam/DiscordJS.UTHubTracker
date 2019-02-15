
const http = require('https');

// Fields to request from the hubtracker api
const keys = [
	'Instances',
	'Instances.GameInstanceID',
	'Instances.RulesTag',
	'Instances.MapName',
	'Instances.GameTime',
	'Instances.TimeLimit',
	'Instances.TeamScores',
	'Instances.Players',
	'Instances.Players.PlayerName',
	'Instances.Players.PlayerId',
	'Instances.Players.PlayerScore',
];

const url = "https://hubtracker.ut4bt.ga/hubs/" + keys.join("+");

// Process GET request
function get() {
	var request = http.request(url, response => {
		response.setEncoding('utf8');
		var buff = "";
		response.on('data', chunk => buff += chunk);
		response.on('end', _ => {
			onResponse(JSON.parse(buff));
		});
	});
	request.on('error', err => console.error(err));
	request.end();
}
get();

var previousData = {};

function onResponse(data) {
	// next in 30 seconds
	setTimeout(get, 30000);

	console.log("GET = " + data.status);

	if ( data.status != 'OK' )
		return;

	for ( var hubName in data.data ) {
		if ( previousData[hubName] )
			diffHub(data.data[hubName], previousData[hubName]);
	}

	previousData = data.data;
}

function diffHub(dataNew, dataOld) {
	// map instances by InstanceID
	var instancesNew = {}, instancesOld = {};
	dataNew.Instances.forEach(i => instancesNew[i.GameInstanceID] = i);
	dataOld.Instances.forEach(i => instancesOld[i.GameInstanceID] = i);

	// iterate new instances
	for ( var id in instancesNew ) {
		if ( instancesOld[id] )
			diffInstance(instancesNew[id], instancesOld[id]);
		else
			console.log("New instance created", instancesNew[id]);
	}

	// old instances destroyed
	for ( var id in instancesOld ) {
		if ( !instancesNew[id] )
			console.log("Instance destroyed", instancesOld[id]);
	}
}

function diffInstance(dataNew, dataOld) {
	console.log("Diff instance " + dataNew.GameInstanceID);

	// Detect mapchange
	if ( tryDetectMapChange(dataNew, dataOld) )
		console.log("   Map change", dataOld.MapName, "->", dataNew.MapName);

	// Detect match start
	if ( dataOld.GameTime == 0 && dataNew.GameTime > 0 ) {
		// this should work for both clock directions
		// although the increasing one will be 1 minute late
		//NOTE: need to check how overtime and intermissions work, might break this
		console.log("   Match started");
	}

	// Players
	// map by PlayerId
	var playersNew = {}, playersOld = {};
	dataNew.Players.forEach(p => playersNew[p.PlayerId] = p);
	dataOld.Players.forEach(p => playersOld[p.PlayerId] = p);
	// iterate new players
	for ( var id in playersNew ) {
		if ( !playersOld[id] )
			console.log("   Player joined", playersNew[id]);
	}
	// old players left
	for ( var id in playersOld ) {
		if ( !playersNew[id] )
			console.log("   Player left", playersOld[id]);
	}
}

// Detecting map change
// Some notes:
// - Relying on MapName only works if you are certain players are going to play different maps
// - When TimeLimit=0, clock goes up
// - When TimeLimit>0, clock goes down after match start
// - GameTime is always 0 during warmup

// Best effort to detect map change
// Some edge cases can always skip through, if mapvote and/or warmup go very quick (no time to update)
function tryDetectMapChange(dataNew, dataOld) {

	// MapName
	if ( dataNew.MapName != dataOld.MapName )
		return true;

	// When clock goes up, we can rely on GameTime
	if ( dataNew.TimeLimit == 0 && dataNew.GameTime == 0 && (dataOld.GameTime > 0 || dataOld.anyScore > 0) )
		return true;

	// If any score is not 0, then match has started
	dataNew.anyScore = 0;
	for ( var i=0; i<dataNew.TeamScores.length; i++ )
		dataNew.anyScore += Math.abs(dataNew.TeamScores[i]);
	for ( var i=0; i<dataNew.Players.length; i++ )
		dataNew.anyScore += Math.abs(dataNew.Players[i].PlayerScore);

	// When clock goes down there is not much we can rely on
	// Even using scores, main problem is we can go from -1 to 0 (esp. in duel)
	// Need to expose a new field for this

	return false;
}
