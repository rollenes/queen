var EventEmitter = require('events').EventEmitter,
	_ = require('underscore'),
	path = require('path'),
	express = require('express'),
	http = require('http'),
	precondition = require('precondition')
	generateId = require('node-uuid').v4;

var utils = require('./utils.js'),
	createWorkerProvider  = require('./browserWorkerProvider.js'),
	createWorkforce = require('./workforce.js').create;

var STATIC_DIR = path.resolve(path.dirname(module.filename), '../../static');

var create = module.exports = function(options){
	options = options || {};

	var socket,
		httpServer,
		socketServer,
		queen,
		callback = options.callback || utils.noop,
		port = options.port || 80,
		host = options.host,
		autoSpawn = options.autoSpawn || [],
		expressServer = express(),
		webRoot = STATIC_DIR,
		capturePath = "/capture.html",
		captureUrl = "http://" + (host || "localhost") + ":" + port + capturePath,
		httpServer;

	// Setup http server to capture browsers with
	httpServer = http.createServer();
	httpServer.on('request', expressServer);
	httpServer.on('error', function(error){
		queen.log('Error getting access to start HTTP server on ' + (host || "*") + ":" + port);
		queen.log(error);
	});
	httpServer.on('listening', function(error){
		queen.log('Listening for browsers on ' + (host || "*") + ":" + port );
		callback(queen.api);
	});
	httpServer.listen(port, host);
	expressServer.use('', express.static(webRoot));

	// init socket.io
	socketServer = require("socket.io").listen(httpServer, {log: false});
	socket = socketServer.of("/capture");



	queen = new Queen(socket, captureUrl, autoSpawn);

	if(options.log) queen.log = options.log;
	if(options.debug) queen.debug = options.debug;
	if(options.registerationTimeout) queen.registerationTimeout = options.registerationTimeout;
};

module.exports.STATIC_DIR = STATIC_DIR;

var Queen = function(socket, captureUrl, autoSpawn){
	precondition.checkDefined(socket, "Queen requires a socket");

	this.emitter = new EventEmitter();
	this.workforces = {};
	this.workerProviders = {};
	this.socket = socket;
	this.continuousWorkforces = {};
	this.captureUrl = captureUrl;
	this.populators = [];
	this.autoSpawn = autoSpawn;
	this.spawnedClients = {};

	socket.on('connection', this.connectionHandler.bind(this));

	this.kill = _.once(this.kill.bind(this));

	Object.defineProperty(this, "api", { 
		value: Object.freeze(getApi.call(this)),
		enumerable: true 
	});
};

var getApi = function(){
	var self = this,
		api = this.getWorkforce.bind(this);

	api.on = this.emitter.on.bind(this.emitter);
	api.removeListener = this.emitter.removeListener.bind(this.emitter);
	api.kill = this.kill;
	api.getWorkerProvider = this.getWorkerProvider.bind(this);
	api.attachPopulator = this.attachPopulator.bind(this);
	api.detachPopuulator = this.detachPopulator.bind(this);

	Object.defineProperty(api, 'workerProviders', {
		enumerable: true,
		get: function(){
			return _.values(self.workerProviders);
		}
	});

	return api;
};

Queen.prototype.debug = utils.noop;
Queen.prototype.log = utils.noop;
Queen.prototype.registerationTimeout = 10 * 1000; // 10 seconds

Queen.prototype.kill = function(callback){
	var waitingCounter = 0;
	function decrementWaitingCounter(){
		waitingCounter--;
		if(waitingCounter === 0 && callback){
			callback();
		}
	}

	_.each(this.workforces, function(workforce){
		workforce.kill();
	});

	_.each(this.workerProviders, function(workerProvider){
		workerProvider.kill();
	});
	
	_.each(this.spawnedClients, function(client){
		waitingCounter++;
		client.kill(decrementWaitingCounter);
	});

	this.emitter.emit('dead');
	this.emitter.removeAllListeners();
	this.log("Dead");
};

Queen.prototype.addWorkerProvider = function(workerProvider){
	var	self = this;

	var clientId = workerProvider.attributes.populatorClientId;
	
	this.workerProviders[workerProvider.id] = workerProvider;		
	workerProvider.on('dead', function(){
		self.log('Worker provider dead: ' + workerProvider);
		self.emitter.emit('workerProviderDead', workerProvider.id);
		delete self.workerProviders[workerProvider.id];

		if(clientId && clientId in self.spawnedClients){
			var client = self.spawnedClients[clientId];
			client.kill();
		}
	});

	workerProvider.on('unresponsive', function(){
		self.log('Unresponsive: ' + workerProvider.toString());
	
		if(clientId && clientId in self.spawnedClients){
			var client = self.spawnedClients[clientId];
			client.kill();
		}
		self.log(workerProvider.attributes.populatorClientId);
	});


	workerProvider.on('responsive', function(){
		self.log('Responsive again: ' + workerProvider.toString());
	});

	this.log('New worker provider: ' + workerProvider.toString());
	this.emitter.emit('workerProvider', workerProvider);

	_.each(this.continuousWorkforces, function(workforce){
		workforce.populate(workerProvider);
	});
};

Queen.prototype.getWorkerProvider = function(id){
	return this.workerProviders[id];
};

Queen.prototype.getWorkerProviders = function(){
	return _.values(this.workerProviders);
};

Queen.prototype.attachPopulator = function(populator){
	this.populators.push(populator);
	this.autoSpawnClients();
};

Queen.prototype.autoSpawnClients = function(){
	var self = this,
		index = 0,
		fulfilled = [];

	function tryNextPopulator(){
		if(index >= self.populators.length) return;
		var populator = self.populators[index++],
			remaining = [];

		self.autoSpawn.forEach(function(spawnOptions, index){
			var clientId = generateId();
			spawnOptions.captureUrl = self.captureUrl + "?clientId=" + clientId;
			populator(spawnOptions, function(client){
				// If populator was unable to spawn the client, add it back to
				// the queue
				if(!client){
					remaining.push(spawnOptions);
					return;
				}

				self.spawnedClients[clientId] = client;
				client.on('dead', function(){
					delete self.spawnedClients[clientId];
					self.autoSpawn.push(spawnOptions);
					self.autoSpawnClients();
				});
			});
		});

		self.autoSpawn = remaining;

		if(self.autoSpawn.length > 0) tryNextPopulator();
	}
	tryNextPopulator();
};

Queen.prototype.detachPopulator = function(populator){
	var index = this.populators.indexOf(populator);
	if(~index) return;
	this.populators.slice(index, 1);
};

Queen.prototype.connectionHandler = function(connection){
	var self = this,
		timer;
	
	this.debug('New connection');

	var workerProvider = createWorkerProvider(connection, {log: this.log, debug: this.debug});

	timer = setTimeout(function(){
		self.debug('Connection timeout');
		connection.disconnect();
	}, this.registerationTimeout);
	
	workerProvider.on('register', function(){
		clearTimeout(timer);
		self.addWorkerProvider(workerProvider);
	});
};

Queen.prototype.getWorkforce = function(config){
	precondition.checkDefined(config, "Worker config must be defined");

	var self = this,
		workerProviders,
		workforceId = generateId(),
		workforce;

	workforce = createWorkforce(config, {
		workerHandler: config.handler,
		stopHandler: config.stop,
		providerFilter: config.filter,
		killOnStop: config.killOnStop
	});

	if(config.workforceTimeout){
		timeout = setTimeout(function(){
			workforce.kill();
		}, config.workforceTimeout);

		workforce.api.on('dead', function(){
			clearTimeout(timeout);
		});
	}

	this.workforces[workforceId] = workforce.api;
	
	workforce.api.on('dead', function(){
		self.debug('Workforce dead');
		self.emitter.emit('workforceDead', workforce.api.id);
		delete self.workforces[workforceId];
	});

	if(config.populate !== "manual"){
		workforce.api.on('start', function(){
			workforce.populate(self.getWorkerProviders());

			if(config.populate === "continuous"){
				self.continuousWorkforces[workforceId] = workforce;			
				workforce.api.on('dead', function(){
					delete self.continuousWorkforces[workforceId];
				});
			}
		});
	}
	
	if(config.autoStart !== false){
		workforce.start();
	}

	this.debug('New workforce');
	this.emitter.emit('workforce', workforce.api);

	return workforce.api;
};