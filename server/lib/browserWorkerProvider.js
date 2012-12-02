var EventEmitter = require('events').EventEmitter,
	_ = require('underscore'),
	useragent = require("useragent"),
	generateId = require('node-uuid').v4,
	precondition = require('precondition');

var createWorker = require('./worker.js'),
	utils = require('./utils.js');

var create = module.exports = function(socket, options){
	precondition.checkDefined(socket, "BrowserWorkerProvider requires a socket.");

	options = options || {};

	var self = {
		id: generateId(),
		socket: socket,
		emitter: new EventEmitter(),
		workerEmitters: {},
		workerCount: 0,
		maxWorkers: options.maxWorkers || 1000,
		log: options.logger || utils.noop
	};

	self.kill = kill.bind(self);
	self.sendToSocket = sendToSocket.bind(self);
	self.messageHandler = messageHandler.bind(self);
	self.registerHandler = registerHandler.bind(self);
	self.workerMessageHandler = workerMessageHandler.bind(self);
	self.workerDeadHandler = workerDeadHandler.bind(self);
	self.removeWorker = removeWorker.bind(self);
	self.api = getApi.call(self);
	
	socket.on('disconnect', self.kill);
	socket.on('message', self.messageHandler);
	
	return  self.api;
};

var getApi = function(){
	var self = this,
		api = getWorker.bind(this);
	
	api.on = this.emitter.on.bind(this.emitter);
	api.removeListener = this.emitter.removeListener.bind(this.emitter);
	
	Object.defineProperty(api, "id", { 
		value: this.id,
		enumerable: true 
	});

	Object.defineProperty(api, "attributes", { 
		get: function(){ return self.attributes; },
		enumerable: true 
	});

	Object.defineProperty(api, "workerCount", { 
		get: function(){ return self.workerCount; },
		enumerable: true 
	});

	Object.defineProperty(api, "maxWorkerCount", { 
		get: function(){ return self.maxWorkerCount; },
		enumerable: true 
	});

	return api;
};

var sendToSocket = function(message){
	message = JSON.stringify(message);
	this.socket.send(message);
};

var messageHandler = function(message){
	message = JSON.parse(message);
	switch(message.type){
		case "workerMessage":
			this.workerMessageHandler(message);
			return;
		case "register":
			this.registerHandler(message);
			return;
		case "workerDead":
			this.workerDeadHandler(message);
			return;
	}
};

var workerDeadHandler = function(message){
	var workerEmitter = this.workerEmitters[message.id];
	if(workerEmitter === void 0) return;
	workerEmitter.emit('dead');
};

var registerHandler = function(message){
	var attributes = message.attributes || {},
		ua;

	if(attributes.userAgent){
		ua = useragent.parse(attributes.userAgent);
		attributes.name = ua.toAgent();
		attributes.family = ua.family;
		attributes.os = ua.os;
		attributes.version = {
			major: ua.major,
			minor: ua.minor,
			path: ua.patch
		};
	}

	Object.freeze(attributes);

	this.attributes = attributes;

	this.emitter.emit('register', attributes);
};

var kill = function(){
	var self = this;
	_.each(this.workerEmitters, function(workerEmitter, workerId){
		self.socket.emit('killWorker', workerId);
		workerEmitter.emit('dead'); // Emulate the immediate death of the socket
	});
	this.workerEmitters = {};
	this.emitter.emit('dead');
	this.emitter.removeAllListeners();
};

var workerMessageHandler = function(message){
	var workerEmitter = this.workerEmitters[message.id];
	if(workerEmitter === void 0) return;
	workerEmitter.emit("message", message.message);
};

var getWorker = function(workerConfig){
	var self = this;

	if(workerConfig === void 0) return;

	if(this.workerCount >= this.maxWorkers){
		this.log("Unable to spawn worker because of reached limit");
		return;
	}

	var workerId = generateId(),
		workerEmitter = new EventEmitter(),
		onSendToSocket = function(message){
			self.sendToSocket({
				type: "workerMessage",
				id: workerId,
				message: message
			});
		},
		worker = createWorker(workerId, this.api, workerEmitter, onSendToSocket);
	
	this.workerEmitters[workerId] = workerEmitter;

	// Handle the case when a kill signal is sent from the server side
	worker.on("dead", function(){
		var workerEmitter = self.workerEmitters[workerId];
		if(workerEmitter !== void 0){
			self.sendToSocket({
				type: "killWorker",
				id: workerId
			});

			self.removeWorker(workerId);
		}
	});

	this.sendToSocket({
		type: "spawnWorker",
		id: workerId,
		config: workerConfig
	});

	this.workerCount++;
	if(this.workerCount === this.maxWorkers){
		this.log("Worker capacity reached, unable to spawn additional workers");
		this.emitter.emit("unavailable");
	}

	this.emitter.emit('newWorkerCount', this.workerCount);

	return worker;
};

var removeWorker = function(workerId){
	delete this.workerEmitters[workerId];

	if(this.workerCount-- === this.maxWorkers){
		this.log("Able to spawn more workers");
		this.emitter.emit('newWorkerCount', this.workerCount);
		this.emitter.emit('available');
	}
};