/**
 * Copyright 2013,2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

module.exports = function(RED) {
    "use strict";
    var ws = require("ws");
    var inspect = require("util").inspect;
    var DataView = require('buffer-dataview');

	//BLYNK STUFF
    function messageToDebugString(bufArray) {
        var dataview = new DataView(bufArray);
        var cmdString = getStringByCommandCode(dataview.getInt8(0));
        var msgId = dataview.getUint16(1);
        var responseCode = getStatusByCode(dataview.getUint16(3));
        return "Command : " + cmdString + ", msgId : " + msgId + ", responseCode : " + responseCode;
    }
    
    function decodeCommand(bufArray) {
        var dataview = new DataView(bufArray);
        var command = {};
        command.type = dataview.getInt8(0);
        command.typeString = getStringByCommandCode(dataview.getInt8(0));
        command.msgId = dataview.getUint16(1);
        
        if(command.type == MsgType.HARDWARE) {
			command.len = dataview.getUint16(3);;

			command.body = '';
			for (var i = 0, offset =  5; i < command.len; i++, offset ++) {
                //dataview.setInt8(offset, cmdBody.charCodeAt(i));
                command.body += String.fromCharCode(dataview.getInt8(offset));
            }
            if(command.body != '') {
	            var values = command.body.split('\0');
	            if(values.length > 1) {
		            command.operation = values[0];
		            command.pin = values[1];
		            if(values.length > 2) {
			            command.value = values[2];
						//we have an array of commands, return array as well
						command.array = values.slice(2, values.length);
		            }
		            
	            }
            }
            //console.log(command);
        } else {
	        command.status = dataview.getUint16(3);
        }
        
        //console.log(command);
        
        return command;
    }
    
    //send
    //create message
    //- get command by string
    //- build blynk message
    //send
    
    /*
    function send(socket, data) {
        if (socket.readyState == ws.OPEN) {
            var commandAndBody = data.split(" ");
            var message = createMessage(commandAndBody);
            //console.log('sending : ' + data + '\r\n', message);
        
            socket.send(message);
        } else {
            console.log("The socket is not open.");
        }
    }
    
    function createMessage(commandAndBody) {
        var cmdString = commandAndBody[0];
        var cmdBody = commandAndBody.length > 1 ? commandAndBody.slice(1).join('\0') : null;
        var cmd = getCommandByString(cmdString);
        return buildBlynkMessage(cmd, 1, cmdBody);
    }
    */
    function encodeCommand(command, msgId, body) {
        var BLYNK_HEADER_SIZE = 5;
        //console.log('encode', command, body);
        var bodyLength = (body ? body.length : 0);
        var bufArray = new Buffer(BLYNK_HEADER_SIZE + bodyLength);
        var dataview = new DataView(bufArray);
        dataview.setInt8(0, command);
        dataview.setInt16(1, msgId);
        dataview.setInt16(3, bodyLength);
        if (bodyLength > 0) {
            //todo optimize. should be better way
            var buf = new ArrayBuffer(bodyLength); // 2 bytes for each char
            var bufView = new Uint8Array(buf);
            for (var i = 0, offset =  5; i < body.length; i++, offset += 1) {
                dataview.setInt8(offset, body.charCodeAt(i));
            }
        }
        return new Uint8Array(bufArray);
    }
    
    
    var MsgType = {
	    RESPONSE      :  0,
	    LOGIN         :  2,
	    PING          :  6,
	    TWEET         :  12,
	    EMAIL         :  13,
	    NOTIFY        :  14,
	    BRIDGE        :  15,
	    HW_SYNC       :  16,
	    HW_INFO       :  17,
	    HARDWARE      :  20
	};
	
	var MsgStatus = {
	    OK                    :  200,
	    ILLEGAL_COMMAND       :  2,
	    NO_ACTIVE_DASHBOARD   :  8,
	    INVALID_TOKEN         :  9,
	    ILLEGAL_COMMAND_BODY  : 11
	};
	
	function getCommandByString(cmdString) {
	    switch (cmdString) {
	        case "ping" :
	            return MsgType.PING;
	        case "login" :
	            return MsgType.LOGIN;
	        case "hardware" :
	            return MsgType.HARDWARE;
	    }
	}
	
	function getStringByCommandCode(cmd) {
	    switch (cmd) {
	        case 0 :
	            return "RESPONSE";
	        case 20 :
	            return "HARDWARE";
	    }
	}
	
	function getStatusByCode(statusCode) {
	    switch (statusCode) {
	        case 200 :
	            return "OK";
	        case 2 :
	            return "ILLEGAL_COMMAND";
	        case 8 :
	            return "NO_ACTIVE_DASHBOARD";
	        case 9 :
	            return "INVALID_TOKEN";
	        case 11 :
	            return "ILLEGAL_COMMAND_BODY";
	    }
	}
	//END BLYNK STUFF



    // A node red node that sets up a local websocket server
    function BlynkClientNode(n) {
        // Create a RED node
        RED.nodes.createNode(this,n);
        var node = this;

        // Store local copies of the node configuration (as defined in the .html)
        node.path = n.path;
        node.key = n.key;
        node.wholemsg = (n.wholemsg === "true");

        node._inputNodes = [];    // collection of nodes that want to receive events
        node._clients = {};
        // match absolute url
        node.isServer = false;
        node.closing = false;
		node.working = false;
		
		node.setMaxListeners(100);
		
		node.pinger = setInterval(function() {
			//only ping if connected and working
        	if(node.working) {
	        	node.ping();
        	}
    	}, 5000);
		
        function startconn() {    // Connect to remote endpoint
	        //should not start connection if no server or key
	        node.working = false;
            var socket = new ws(node.path);
			//socket.binaryType = 'arraybuffer'; //probably does not work
            node.server = socket; // keep for closing
            handleConnection(socket);
        }

        function handleConnection(/*socket*/socket) {
            var id = (1+Math.random()*4294967295).toString(16);
            socket.setMaxListeners(100);
            socket.on('open',function() {
	            console.log('open');
	            node.working = false;
	            //do login
	            //send(node.server, 'login ' + node.key )
	            node.login(node.key);
                node.emit('opened','');
            });
            
            socket.on('close', function() {
	            console.log('close');
                node.emit('closed');
                node.working = false;
                if (!node.closing) {
                    node.tout = setTimeout(function(){ startconn(); }, 5000); // try to reconnect every 5 secs... bit fast ?
                }
            });
            socket.on('message', function(data, flags) {
	            //should check if login message OK, then set to working state
	            var cmd = decodeCommand(data);
	            //first ok is a valid login
	            if(!node.working && cmd.type == MsgType.RESPONSE && cmd.status == MsgStatus.OK) {
		            console.log('valid login, start everything');
					node.working = true;
					node.emit('connected','');
		            //start ping
	            } else {
		            //should really just send command
	                //node.handleEvent(id, socket, 'message', data, flags);
	                switch(cmd.type) {
		                //MsgType.LOGIN
		                case MsgType.RESPONSE:
		                	//console.log()
		                	//response, ignoring
		                	break;
		                case MsgType.HARDWARE:
		                	switch(cmd.operation) {
			                	//input nodes
			                	case 'vw':
			                		node.handleWriteEvent(cmd);
			                		break;
			                	case 'vr':
			                		node.handleReadEvent(cmd);
			                		break;
			                	default:
			                		console.log('Unhandled operation', cmd);
		                	}
		                	break;
						default:
							console.log('Unhandled response', cmd);
					}
	            }
            });
            socket.on('error', function(err) {
	            console.log('error');
                node.emit('erro');
                node.working = false;
                if (!node.closing) {
                    node.tout = setTimeout(function(){ startconn(); }, 5000); // try to reconnect every 5 secs... bit fast ?
                }
            });
        }


        node.closing = false;
        startconn(); // start outbound connection

        node.on("close", function() {
            // Workaround https://github.com/einaros/ws/pull/253
            // Remove listeners from RED.server
            
            node.closing = true;
            node.working = false;
            node.server.close();
            if (node.tout) { clearTimeout(node.tout); }
        });
        
        
        
    }

    RED.nodes.registerType("blynk-websockets-client", BlynkClientNode);

    BlynkClientNode.prototype.registerInputNode = function(/*Node*/handler) {
        this._inputNodes.push(handler);
    }

    BlynkClientNode.prototype.removeInputNode = function(/*Node*/handler) {
        this._inputNodes.forEach(function(node, i, inputNodes) {
            if (node === handler) {
                inputNodes.splice(i, 1);
            }
        });
    }
    
    BlynkClientNode.prototype.login = function(token) {
	    console.log('handle login', token);
    	//send(this.server, 'login ' + token);
    	this.server.send(encodeCommand(MsgType.LOGIN, 1, token));
   	}    

    BlynkClientNode.prototype.ping = function() {
	    //console.log('ping');
    	//send(this.server, 'login ' + token);
    	this.server.send(encodeCommand(MsgType.PING, 1, ''));
   	}    
	
    BlynkClientNode.prototype.virtualWrite = function(vpin, val) {
	    //console.log('ping');
    	//send(this.server, 'login ' + token);
    	var values = ['vw', vpin, val];
		//console.log(values);
		var data = values.join('\0');
		//console.log(data);		
    	this.server.send(encodeCommand(MsgType.HARDWARE, 1, data));
   	}    

    BlynkClientNode.prototype.sendEmail = function(to, subject, message) {
	    //console.log('ping');
    	//send(this.server, 'login ' + token);
    	//[to, topic, message]
    	var values = [to, subject, message];
		//console.log(values);
		var data = values.join('\0');
		//console.log(data);		
    	this.server.send(encodeCommand(MsgType.EMAIL, null, data));
   	}    
	
   
    BlynkClientNode.prototype.handleWriteEvent = function(command) {
	    console.log('handle request write event', command);
        
        for (var i = 0; i < this._inputNodes.length; i++) {
	        if(this._inputNodes[i].nodeType == 'write' && this._inputNodes[i].pin == command.pin) {
	          	var msg;

		        msg = {
		            payload: command.value
		        };
				
				if(command.array) {
					msg.arrayOfValues = command.array;
				}

	            this._inputNodes[i].send(msg);
	        }
        }
	}    
	
	BlynkClientNode.prototype.handleReadEvent = function(command) {
	    console.log('handle request read event', command.pin);
       //msg._session = {type:"websocket", id:id};
        
        for (var i = 0; i < this._inputNodes.length; i++) {
	        if(this._inputNodes[i].nodeType == 'read' && this._inputNodes[i].pin == command.pin) {
	          	var msg;

		        msg = {
		            payload: this._inputNodes[i].pin
		        };

	            this._inputNodes[i].send(msg);
	        }
        }
	}

    BlynkClientNode.prototype.handleEvent = function(command) {
	    console.log('handle event', command);
	    
	    var msg;

        msg = {
            payload:0
        };

        //msg._session = {type:"websocket", id:id};
        
        for (var i = 0; i < this._inputNodes.length; i++) {
	        if(this._inputNodes[i].nodeType == cmd.action) {
	            this._inputNodes[i].send(msg);
	        }
        }
        
		/*if (data instanceof Buffer) {
            console.log(">>>", data);
            console.log("Receive : " +  messageToDebugString(data) + "\r\n");
        } else {
            console.log("unexpected type : " + data + "\r\n");
        }


        var msg;
        if (this.wholemsg) {
            try {
                msg = JSON.parse(data);
            }
            catch(err) {
                msg = { payload:data };
            }
        } else {
            msg = {
                payload:data
            };
        }
        msg._session = {type:"websocket",id:id};
        for (var i = 0; i < this._inputNodes.length; i++) {
            this._inputNodes[i].send(msg);
        }*/
    }
/*
    WebSocketListenerNode.prototype.broadcast = function(data) {
        try {
            this.server.send(data);
        }
        catch(e) { // swallow any errors
            this.warn("ws:"+i+" : "+e);
        }
    }
*/
/*
    WebSocketListenerNode.prototype.reply = function(id,data) {
        var session = this._clients[id];
        if (session) {
            try {
                session.send(data);
            }
            catch(e) { // swallow any errors
            }
        }
    }
*/
    function BlynkInReadNode(n) {
        RED.nodes.createNode(this, n);
        this.server = (n.client)?n.client:n.server;
        var node = this;
        this.serverConfig = RED.nodes.getNode(this.server);
        
		this.nodeType = 'read';
		this.pin = n.pin;
		console.log('new in read', this.pin);
        
        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on('opened', function(n) { node.status({fill:"yellow",shape:"dot",text:"connecting "+n}); });
            this.serverConfig.on('connected', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
        } else {
            this.error(RED._("websocket.errors.missing-conf"));
        }

        this.on('close', function() {
            node.serverConfig.removeInputNode(node);
        });

    }
    RED.nodes.registerType("blynk-websockets-in-read", BlynkInReadNode);


    function BlynkInWriteNode(n) {
        RED.nodes.createNode(this, n);
        this.server = (n.client)?n.client:n.server;
        var node = this;
        this.serverConfig = RED.nodes.getNode(this.server);
        
		this.nodeType = 'write';
		this.pin = n.pin;
		console.log('new in write', this.pin);
        
        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on('opened', function(n) { node.status({fill:"yellow",shape:"dot",text:"connecting "+n}); });
            this.serverConfig.on('connected', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
        } else {
            this.error(RED._("websocket.errors.missing-conf"));
        }

        this.on('close', function() {
            node.serverConfig.removeInputNode(node);
        });

    }
    RED.nodes.registerType("blynk-websockets-in-write", BlynkInWriteNode);

    function BlynkOutWriteNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = n.client;
		this.pin = n.pin;
        
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(n) { node.status({fill:"yellow",shape:"dot",text:"connecting "+n}); });
            this.serverConfig.on('connected', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
        }
        this.on("input", function(msg) {
            var payload;
            //console.log('writing');
            /*if (this.serverConfig.wholemsg) {
                delete msg._session;
                payload = JSON.stringify(msg);
            } else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id, payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error){
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }*/
            
            if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
	            //todo: check payload and validate
	            //console.log('write');
	            node.serverConfig.virtualWrite(node.pin, payload);
            }

            
        });
    }
    RED.nodes.registerType("blynk-websockets-out-write", BlynkOutWriteNode);

    function BlynkOutEmailNode(n) {
        RED.nodes.createNode(this,n);
        var node = this;
        this.server = n.client;
        this.email = n.email;
        
        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            this.error(RED._("websocket.errors.missing-conf"));
        }
        else {
            // TODO: nls
            this.serverConfig.on('opened', function(n) { node.status({fill:"yellow",shape:"dot",text:"connecting "+n}); });
            this.serverConfig.on('connected', function(n) { node.status({fill:"green",shape:"dot",text:"connected "+n}); });
            this.serverConfig.on('erro', function() { node.status({fill:"red",shape:"ring",text:"error"}); });
            this.serverConfig.on('closed', function() { node.status({fill:"red",shape:"ring",text:"disconnected"}); });
        }
        this.on("input", function(msg) {
            var payload;
            //console.log('writing');
            /*if (this.serverConfig.wholemsg) {
                delete msg._session;
                payload = JSON.stringify(msg);
            } else if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
                if (msg._session && msg._session.type == "websocket") {
                    node.serverConfig.reply(msg._session.id, payload);
                } else {
                    node.serverConfig.broadcast(payload,function(error){
                        if (!!error) {
                            node.warn(RED._("websocket.errors.send-error")+inspect(error));
                        }
                    });
                }
            }*/
            
            if (msg.hasOwnProperty("payload")) {
                if (!Buffer.isBuffer(msg.payload)) { // if it's not a buffer make sure it's a string.
                    payload = RED.util.ensureString(msg.payload);
                }
                else {
                    payload = msg.payload;
                }
            }
            if (payload) {
	            //todo: check payload and validate
	            //console.log('write');
	            var subject = payload;
	            if(msg.topic) {
		            subject = msg.topic;
	            }
	            node.serverConfig.sendEmail(node.email, subject, payload);
            }

            
        });
    }
    RED.nodes.registerType("blynk-websockets-out-email", BlynkOutEmailNode);


}