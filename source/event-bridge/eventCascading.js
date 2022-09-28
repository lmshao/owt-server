// Copyright (C) <2019> Intel Corporation
//
// SPDX-License-Identifier: Apache-2.0

'use strict';

var logger = require('./logger').logger;
var log = logger.getLogger('EventCascading');
var quicCas = require('./quicCascading/build/Release/quicCascading.node');
const inspector = require('event-loop-inspector')();

var cf = 'leaf_cert.pem';
var kf = 'leaf_cert.pkcs8';

var EventCascading = function(spec, rpcReq) {
  var that = {},
    port = spec.port,
    cluster_name = spec.clusterName,
    self_rpc_id = spec.selfRpcId;

  /*
   * {conferenRpcId: {
   *     clientID/sessionId : { 
   *     stream: quicStreamObject
   * }}}
   */
  var controllers = {};
  var cascadedRooms = {};

  /*
   * {
   *    sessionId: {
   *       session : quicSessionObject,
   *       id      : quicSessionId,
   *       target  : targetCluster,
   *       streams : {
   *         streamId: {
   *           stream: quicStreamObject,
   *           controller: conferenceRPCId
   *         }
   *       }
   *     }
   * }
   */
  var server, sessions = {};

  /*setInterval(() => {
    console.log('IMOK');
  }, 1000);*/

  that.notify = function (participantId, msg, data) {
    if (controllers[msg.rpcId]) {
      if (msg.type === 'initialize') {
        log.info("Send initialize data to session:",msg.session, " and data:", data);
        if (sessions[msg.session].streams[msg.stream]) {
          sessions[msg.session].streams[msg.stream].quicstream.send(JSON.stringify(data));
        } else {
          log.error("Quic stream abnormal");
        }
        
      } else {
        for (var item in controllers[msg.rpcId]) {
          log.info("Notify msg:", msg, " with data:", data, " to stream:", item, " controllers:", controllers);
          controllers[msg.rpcId][item].send(JSON.stringify(data));
        }
      }
      return Promise.resolve('ok');
    } else {
      log.error("Quic connection abnormal");
      return Promise.reject('Quic connection abnormal');
    }
  }

  that.destroyRoom = function (data) {
    //Close related quic stream if room is destroyed
    for (var item in controllers[msg.rpcId]) {
      log.info("destroyRoom with data:", data);
      controllers[msg.rpcId][item].close();
      delete controllers[msg.rpcId][item];
    }

    cascadedRooms[data.room] = false;
  }

  const createQuicStream = (controller, clientID, data) => {
    log.info("Create quic stream with controller:", controller, " clientID:", clientID, " and data:",data);
    var quicStream = sessions[clientID].quicsession.createBidirectionalStream();
    var streamID = quicStream.getId();
    var id = clientID + '-' + streamID;

    if (!sessions[clientID].streams) {
      sessions[clientID].streams = {};
    }

    if (!sessions[clientID].streams[streamID]) {
      sessions[clientID].streams[streamID] = {};
    }
    sessions[clientID].streams[streamID].quicstream = quicStream;
    sessions[clientID].streams[streamID].controller = controller;

    if (!controllers[controller]) {
      controllers[controller] = {};
    }

    if (!controllers[controller][id]) {
      controllers[controller][id] = {};
    }
    controllers[controller][id] = quicStream;
    var info = {
      type: 'bridge',
      room: data.room
    }

    var info = {
      type: 'ready',
      target: data.selfCluster
    }
    quicStream.send(JSON.stringify(info));
    
    quicStream.onStreamData((msg) => {
      log.info("quic client stream get data:", msg);
      var event = JSON.parse(msg);
      if (event.type === 'ready') {
        var info = {
          type: 'bridge',
          room: data.room
        }
        quicStream.send(JSON.stringify(info));
      } else {
        if (event.type === 'initialize') {
          rpcReq.onCascadingConnected(controller, self_rpc_id, clientID, streamID);
        } 
        rpcReq.handleCascadingEvents(controller, self_rpc_id, data.targetCluster, event);
      }
    })
  }

  that.startCascading = function (data, on_ok, on_error) {
    var clientID = data.evIP.replace(/\./g, '-') + '-' + data.evPort;
    log.info("startEventCascading with data:", data, " clientID:", clientID);

    //A new conference request between uncascaded clusters
    if(!sessions[clientID]) {
      return rpcReq.getController(cluster_name, data.room)
        .then(function(controller) {
  	      log.info("Client get controller:", controller);
          sessions[clientID] = {};
          var client = new quicCas.QuicTransportClient(data.evIP, data.evPort);
		      client.connect();
          sessions[clientID].quicsession = client;
          sessions[clientID].target = data.targetCluster;
          cascadedRooms[data.room] = true;
          client.dest = clientID;
          client.onConnection(() => {
		        log.info("Quic client connected");
            on_ok('ok');
            sessions[clientID].id = client.getId();
            createQuicStream(controller, clientID, data);
          });

          client.onClosedStream((closedStreamId) => {
            log.info("client stream:", closedStreamId, " is closed");
            var id = client.dest + '-' + closedStreamId;
            delete controllers[controller][id];
            if (sessions[client.dest] && sessions[client.dest].streams[closedStreamId]) {
              var event = {
                type: 'onCascadingDisconnected'
              }
              rpcReq.handleCascadingEvents(sessions[client.dest].streams[closedStreamId].controller, self_rpc_id, sessions[client.dest].target, event);
            }
          })

          client.onConnectionFailed(() => {
            log.info("Quic client failed to connect with:", client.dest);
            delete sessions[client.dest]
          })

          client.onConnectionClosed((sessionId) => {
            log.info("Quic client:", client.dest, " connection closed");
            for (var item in sessions[client.dest].streams) {
              var event = {
                  type: 'onCascadingDisconnected'
                }
              rpcReq.handleCascadingEvents(sessions[client.dest].streams[item].controller, self_rpc_id, sessions[client.dest].target, event);
            }
            delete sessions[client.dest];
          })
        });
    } else {
      //A new different conference request between cascaded clusters
      if (!cascadedRooms[data.room]) {
        return rpcReq.getController(cluster_name, data.room)
                .then(function(controller) {
                  //Create a new quic stream for the new conference to cascading room events
                  createQuicStream(controller, clientID, data);
                });
      } else {
        log.debug('Cluster already cascaded');
        return Promise.resolve('ok');
      }
    }
  }

  that.start = function () {
    server = new quicCas.QuicTransportServer(port, cf, kf);

    server.start();
    server.onNewSession((session) => {
      var sessionId = session.getId();
      session.id = sessionId;
      if (!sessions[sessionId]) {
        sessions[sessionId] = {};
      }
      sessions[sessionId].quicsession = session;

      log.info("Server get new session:", sessionId);
      session.onNewStream((quicStream) => {
	    log.info("Server get new stream:", quicStream);
        var streamId = quicStream.getId();
        if (!sessions[sessionId].streams) {
          sessions[sessionId].streams = {};
        }

        if (!sessions[sessionId].streams[streamId]) {
          sessions[sessionId].streams[streamId] = {};
        }
        sessions[sessionId].streams[streamId].quicstream = quicStream;
        log.info("quicStreams:", sessions);
        var id = sessionId + '-' + streamId;
        session.dest = id;
        quicStream.onStreamData((msg) => {
          var event = JSON.parse(msg);
          log.info("Server get stream data:", event);
          if (event.type === 'bridge') {
            rpcReq.getController(cluster_name, event.room)
            .then(function(controller) {

              sessions[sessionId].streams[streamId].controller = controller;

              if (!controllers[controller]) {
                controllers[controller] = {};
              }

              if (!controllers[controller][id]) {
                controllers[controller][id] = {};
              }

              controllers[controller][id] = quicStream;
              rpcReq.onCascadingConnected(controller, self_rpc_id, sessionId, streamId);
            });
          } else if (event.type === 'ready') {
            var info = {
              type: 'ready'
            }
            sessions[sessionId].target = event.target;
            quicStream.send(JSON.stringify(info));
          } else {
            rpcReq.handleCascadingEvents(sessions[sessionId].streams[streamId].controller, self_rpc_id, sessions[sessionId].target, event);
          }
        });
      })

      session.onClosedStream((closedStreamId) => {
        log.info("server stream:", closedStreamId, " is closed");
          delete controllers[sessions[session.id].streams[closedStreamId].controller][session.dest];
          if (sessions[sessionId] && sessions[session.id].streams[closedStreamId]) {
            var event = {
              type: 'onCascadingDisconnected'
            }
            rpcReq.handleCascadingEvents(sessions[session.id].streams[closedStreamId].controller, self_rpc_id, sessions[session.id].target, event);
            delete sessions[session.id].streams[closedStreamId];
          }          
      })
    });

    server.onClosedSession((sessionId) => {
      log.info("Session:", sessionId, " in server is closed, sessions:", sessions);
      if (sessions[sessionId].streams) {
        for (var item in sessions[sessionId].streams) {
         var event = {
              type: 'onCascadingDisconnected'
            }
            rpcReq.handleCascadingEvents(sessions[sessionId].streams[item].controller, self_rpc_id, sessions[sessionId].target, event);
        }
      }
      
      delete sessions[sessionId];
    })
  }

  that.stop = function () {
    log.info("stop event bridge");
    var event = {
          type: 'onCascadingDisconnected'
        }
    return new Promise((resolve, reject) => {
      for (var item in sessions) {
        sessions[item].quicsession.close();
        for (var id in sessions[item].streams) {
          rpcReq.handleCascadingEvents(sessions[item].streams[id].controller, self_rpc_id, sessions[item].target, event);
        }
      }
      resolve('ok');
    }).then((result) => {
      server.stop();
      return Promise.resolve('ok');
    })
  }


  return that;
};


module.exports = EventCascading;

