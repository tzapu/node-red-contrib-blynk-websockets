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

        if (command.type == MsgType.HARDWARE) {
            command.len = dataview.getUint16(3);;

            command.body = '';
            for (var i = 0, offset = 5; i < command.len; i++, offset++) {
                command.body += String.fromCharCode(dataview.getInt8(offset));
            }
            if (command.body != '') {
                var values = command.body.split('\0');
                if (values.length > 1) {
                    command.operation = values[0];
                    command.pin = values[1];
                    if (values.length > 2) {
                        command.value = values[2];
                        //we have an array of commands, return array as well
                        command.array = values.slice(2, values.length);
                    }

                }
            }
        } else {
            command.status = dataview.getUint16(3);
        }

        return command;
    }

    function encodeCommand(command, msgId, body) {
        var BLYNK_HEADER_SIZE = 5;
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
            for (var i = 0, offset = 5; i < body.length; i++, offset += 1) {
                dataview.setInt8(offset, body.charCodeAt(i));
            }
        }
        return new Uint8Array(bufArray);
    }


    var MsgType = {
        RESPONSE: 0,
        LOGIN: 2,
        PING: 6,
        TWEET: 12,
        EMAIL: 13,
        NOTIFY: 14,
        BRIDGE: 15,
        HW_SYNC: 16,
        HW_INFO: 17,
        HARDWARE: 20
    };

    var MsgStatus = {
        OK: 200,
        ILLEGAL_COMMAND: 2,
        NO_ACTIVE_DASHBOARD: 8,
        INVALID_TOKEN: 9,
        ILLEGAL_COMMAND_BODY: 11
    };

    function getStringByCommandCode(cmd) {
        switch (cmd) {
            case 0:
                return "RESPONSE";
            case 20:
                return "HARDWARE";
        }
    }

    function getStatusByCode(statusCode) {
        switch (statusCode) {
            case 200:
                return "OK";
            case 2:
                return "ILLEGAL_COMMAND";
            case 8:
                return "NO_ACTIVE_DASHBOARD";
            case 9:
                return "INVALID_TOKEN";
            case 11:
                return "ILLEGAL_COMMAND_BODY";
        }
    }
    //END BLYNK STUFF



    // A node red node that sets up a local websocket server
    function BlynkClientNode(n) {
        // Create a RED node
        RED.nodes.createNode(this, n);
        var node = this;
        node.msg_callbacks = [];
        // Store local copies of the node configuration (as defined in the .html)
        node.path = n.path;
        node.key = n.key;

        node._inputNodes = []; // collection of nodes that want to receive events
        node._clients = {};
        // match absolute url
        node.closing = false;
        node.logged = false;

        node.setMaxListeners(100);

        node.pinger = setInterval(function() {
            //only ping if connected and working
            if (node.logged) {
                node.ping();
            }
        }, 5000);

        node.closing = false;

        function startconn() { // Connect to remote endpoint
            //should not start connection if no server or key
            node.log(RED._("Start connection: ") + node.path);
            node.logged = false;
            var socket = new ws(node.path);
            node.server = socket; // keep for closing
            socket.setMaxListeners(100);

            socket.on('open', function() {
                node.login(node.key);
            });

            socket.on('close', function() {
                node.log(RED._("Connection closed: ") + node.path);
                node.emit('closed');
                node.logged = false;
                if (!node.closing) {
                    clearTimeout(node.tout);
                    node.tout = setTimeout(function() {
                        startconn();
                    }, 5000); // try to reconnect every 5 secs... bit fast ?
                }
            });

            socket.on('message', function(data, flags) {
                var cmd = decodeCommand(data);
                if (cmd.type == MsgType.RESPONSE && cmd.msgId && cmd.msgId <= node.msg_callbacks.length) {
                    var err = null
                    if (cmd.status != MsgStatus.OK) {
                        err = cmd.status
                    }
                    node.msg_callbacks[cmd.msgId - 1](cmd, err)
                    node.msg_callbacks.splice(cmd.msgId - 1, 1);
                } else {
                    switch (cmd.type) {
                        case MsgType.HARDWARE:
                            switch (cmd.operation) {
                                //input nodes
                                case 'vw':
                                    node.handleWriteEvent(cmd);
                                    break;
                                case 'vr':
                                    node.handleReadEvent(cmd);
                                    break;
                                default:
                                    node.warn(RED._("Unhandled HARDWARE operation: ") + messageToDebugString(data));
                            }
                            break;
                        default:
                            node.warn(RED._("Unhandled operation type: ") + messageToDebugString(data));
                    }
                }
            });
            socket.on('error', function(err) {
                node.error(RED._("Socket error: ") + err);
                node.emit('erro');
                node.logged = false;
                if (!node.closing) {
                    clearTimeout(node.tout);
                    node.tout = setTimeout(function() {
                        startconn();
                    }, 5000); // try to reconnect every 5 secs... bit fast ?
                }
            });
        }

        node.on("close", function() {
            // Workaround https://github.com/einaros/ws/pull/253
            // Remove listeners from RED.server
            node.closing = true;
            node.logged = false;
            node.server.close();
            if (node.tout) {
                clearTimeout(node.tout);
            }
        });

        startconn(); // start outbound connection

    }

    RED.nodes.registerType("blynk-websockets-client", BlynkClientNode);

    BlynkClientNode.prototype.registerInputNode = function( /*Node*/ handler) {
        this.log(RED._("Register input node"));
        this._inputNodes.push(handler);
    }

    BlynkClientNode.prototype.removeInputNode = function( /*Node*/ handler) {
        this.log(RED._("Remove input node"));
        this._inputNodes.forEach(function(node, i, inputNodes) {
            if (node === handler) {
                inputNodes.splice(i, 1);
            }
        });
    }

    BlynkClientNode.prototype.send_msg = function(command, data, callback) {
        var id = 0
        if (callback) {
            id = this.msg_callbacks.push(callback);
        }
        this.server.send(encodeCommand(command, id, data));
    }

    BlynkClientNode.prototype.login = function(token) {
        this.send_msg(MsgType.LOGIN, token, function(cmd, err) {
            this.log(RED._("Client logged"));
            if (!err) {
                this.logged = true;
                this.emit('opened', '');
            }
        }.bind(this));
    }

    BlynkClientNode.prototype.ping = function() {
        this.send_msg(MsgType.PING, '', function(cmd, err) {});
    }

    BlynkClientNode.prototype.virtualWrite = function(vpin, val) {
        var values = ['vw', vpin, val];
        var data = values.join('\0');
        this.send_msg(MsgType.HARDWARE, data);
    }

    BlynkClientNode.prototype.sendEmail = function(to, subject, message) {
        var values = [to, subject, message];
        var data = values.join('\0');
        this.send_msg(MsgType.EMAIL, data);
    }


    BlynkClientNode.prototype.handleWriteEvent = function(command) {
        for (var i = 0; i < this._inputNodes.length; i++) {
            if (this._inputNodes[i].nodeType == 'write' && this._inputNodes[i].pin == command.pin) {
                var msg;

                msg = {
                    payload: command.value
                };

                if (command.array) {
                    msg.arrayOfValues = command.array;
                }

                this._inputNodes[i].send(msg);
            }
        }
    }

    BlynkClientNode.prototype.handleReadEvent = function(command) {

        for (var i = 0; i < this._inputNodes.length; i++) {
            if (this._inputNodes[i].nodeType == 'read' && this._inputNodes[i].pin == command.pin) {
                var msg;

                msg = {
                    payload: this._inputNodes[i].pin
                };

                this._inputNodes[i].send(msg);
            }
        }
    }

    function BlynkInReadNode(n) {
        RED.nodes.createNode(this, n);
        this.server = (n.client) ? n.client : n.server;
        var node = this;
        this.serverConfig = RED.nodes.getNode(this.server);

        this.nodeType = 'read';
        this.pin = n.pin;

        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on('opened', function(n) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: "connecting " + n
                });
            });
            this.serverConfig.on('connected', function(n) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "connected " + n
                });
            });
            this.serverConfig.on('erro', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "error"
                });
            });
            this.serverConfig.on('closed', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "disconnected"
                });
            });
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
        this.server = (n.client) ? n.client : n.server;
        var node = this;
        this.serverConfig = RED.nodes.getNode(this.server);

        this.nodeType = 'write';
        this.pin = n.pin;

        if (this.serverConfig) {
            this.serverConfig.registerInputNode(this);
            // TODO: nls
            this.serverConfig.on('opened', function(n) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: "connecting " + n
                });
            });
            this.serverConfig.on('connected', function(n) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "connected " + n
                });
            });
            this.serverConfig.on('erro', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "error"
                });
            });
            this.serverConfig.on('closed', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "disconnected"
                });
            });
        } else {
            this.error(RED._("websocket.errors.missing-conf"));
        }

        this.on('close', function() {
            node.serverConfig.removeInputNode(node);
        });

    }
    RED.nodes.registerType("blynk-websockets-in-write", BlynkInWriteNode);

    function BlynkOutWriteNode(n) {
        RED.nodes.createNode(this, n);
        var node = this;
        this.server = n.client;
        this.pin = n.pin;

        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            this.error(RED._("websocket.errors.missing-conf"));
        } else {
            // TODO: nls
            this.serverConfig.on('opened', function(n) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: "connecting " + n
                });
            });
            this.serverConfig.on('connected', function(n) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "connected " + n
                });
            });
            this.serverConfig.on('erro', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "error"
                });
            });
            this.serverConfig.on('closed', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "disconnected"
                });
            });
        }
        this.on("input", function(msg) {
            if (msg.hasOwnProperty("payload") && node.serverConfig && node.serverConfig.logged) {
                var payload = Buffer.isBuffer(msg.payload) ? msg.payload : RED.util.ensureString(msg.payload);
                var subject = msg.topic ? msg.topic : payload;
                node.serverConfig.virtualWrite(node.pin, payload);
            }
        });
    }
    RED.nodes.registerType("blynk-websockets-out-write", BlynkOutWriteNode);

    function BlynkOutEmailNode(n) {
        RED.nodes.createNode(this, n);
        var node = this;
        this.server = n.client;
        this.email = n.email;

        this.serverConfig = RED.nodes.getNode(this.server);
        if (!this.serverConfig) {
            this.error(RED._("websocket.errors.missing-conf"));
        } else {
            // TODO: nls
            this.serverConfig.on('opened', function(n) {
                node.status({
                    fill: "yellow",
                    shape: "dot",
                    text: "connecting " + n
                });
            });
            this.serverConfig.on('connected', function(n) {
                node.status({
                    fill: "green",
                    shape: "dot",
                    text: "connected " + n
                });
            });
            this.serverConfig.on('erro', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "error"
                });
            });
            this.serverConfig.on('closed', function() {
                node.status({
                    fill: "red",
                    shape: "ring",
                    text: "disconnected"
                });
            });
        }
        this.on("input", function(msg) {
            if (msg.hasOwnProperty("payload") && node.serverConfig && node.serverConfig.logged) {
                var payload = Buffer.isBuffer(msg.payload) ? msg.payload : RED.util.ensureString(msg.payload);
                var subject = msg.topic ? msg.topic : payload;
                node.serverConfig.sendEmail(node.email, subject, payload);
            }
        });
    }
    RED.nodes.registerType("blynk-websockets-out-email", BlynkOutEmailNode);


}