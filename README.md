# node-red-contrib-blynk-websockets
Blynk app integration with Node Red using WebSockets protocol

## Websockets version
This works for both local and cloud BLynk servers.
For local, wss:// works if you ve got a certificate installed on BLynk server.
FOr cloud Blynk server, only non ssl, ws:// works for the time being, as there is no SSL cert installed.
You can use ws://cloud.blynk.cc:8082/ws as the server url.

[![NPM](https://nodei.co/npm/node-red-contrib-blynk-websockets.png?mini=true)](https://npmjs.org/package/node-red-contrib-blynk-websockets)
[![npm version](https://badge.fury.io/js/node-red-contrib-blynk-websockets.svg)](https://badge.fury.io/js/node-red-contrib-blynk-websockets)

If you installed Node Red globally use this to install
```npm install --global node-red-contrib-blynk-websockets```

Supports both SSL wss:// and non secured ws:// connection to local server.

### Supported events and widgets
- read event
- write event
- write command
- emails

### Blynk App Settings
Use Raspberry PI as hardware to access 64 virtual pins or Generic Board for 32.

### How to use

TO ADD

### Debug
TO ADD
Use the verbose `-v` flag when starting Node-Red to get more information

### Available Nodes

TO ADD
