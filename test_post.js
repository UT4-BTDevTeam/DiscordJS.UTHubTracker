
const config = require('./config.json');

const http = require('https');

var req = http.request({
	//host   : '127.0.0.1',
	//port   : 10000,
	//path   : '/hub/post',
	host: 'ut4bt.ga',
	port: '443',
	path: '/api/hubtracker',
	method : 'POST',
	headers: {
		'Content-Type' : 'application/json',
		'x-api-token'  : Object.keys(config.server_keys)[0]
	},
}, res => {
	res.setEncoding('utf8');
	res.on('data', chunk => console.log(chunk));
});

req.on('error', err => console.error(err));

var body1 = {
	ServerName  : "Test Fake Hub",
	ElapsedTime : 100,
	Players     : [],
	Instances   : [],
};
var body2 = {
	ServerName  : "Test Fake Hub",
	ElapsedTime : 200,
	Players     : [ {} ],
	Instances   : [{
		CustomGameName : "Chatouille's Game",
		Flags          : 5,
		RulesTitle     : "Bunnytrack",
		MapName        : "BT-ChatoKEK",
		NumPlayers     : 1,
		MaxPlayers     : 10,
		InstanceLaunchTime : 100,
	}],
};
var body3 = {
	ServerName  : "Test Fake Hub",
	ElapsedTime : 10000,
	Players     : [ {}, {}, {} ],
	Instances   : [{
		CustomGameName : "Chatouille's Game",
		Flags          : 5,
		RulesTitle     : "Bunnytrack",
		MapName        : "BT-ChatoKEK",
		NumPlayers     : 1,
		MaxPlayers     : 10,
		InstanceLaunchTime : 100,
	}, {
		CustomGameName : "Elim 21+ only",
		Flags          : 1,
		RulesTitle     : "Custom Absolute Elimination 1.113",
		MapName        : "DM-Cheops-UT4",
		NumPlayers     : 2,
		MaxPlayers     : 8,
		InstanceLaunchTime : 5000,
	}],
};

req.write(JSON.stringify(body3));
req.end();
