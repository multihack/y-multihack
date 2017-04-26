/* globals Y */

var Y = require('yjs')
var Io = require('socket.io-client')
var SimpleSignalClient = require('simple-signal-client')
var Throttle = require('stream-throttle').Throttle
var Wire = require('multihack-wire')
var getBrowserRTC = require('get-browser-rtc')

class Connector extends Y.AbstractConnector {
  constructor (y, opts) {
    super(y, opts)
    
    var self = this
    if (!(self instanceof Connector)) return new Connector(y, opts)

    opts = opts || {}
    opts.role = 'slave'
    self.room = opts.room || 'welcome'
    self.wrtc = opts.wrtc || null
    self.hostname = opts.hostname || 'https://quiet-shelf-57463.herokuapp.com'
    self.nickname = opts.nickname
    self.events = opts.events || function (event, value) {}
    self.id = null
    self.queue = []

    self.reconnect()
  }
}


Connector.prototype._setupSocket = function () {
  var self = this
  
  self._socket.on('forward', function (data) {
    if (data.event === 'yjs') {
      self.receiveMessage(data.id, data.message)
    }
  })
  
  self._socket.on('peer-join', function (data) {
    if (!self.nop2p && !data.nop2p) return // will connect p2p
    
    var fakePeer = {
      metadata: {
        nickname: data.nickname
      },
      id: data.id,
      nop2p: data.nop2p
    }
    self.peers.push(fakePeer)
    
    if (data.nop2p) self.mustForward++
  
    self._onGotPeer(fakePeer)
  })
  
  self._socket.on('peer-leave', function (data) {
    if (!self.nop2p && !data.nop2p) return // will disconnect p2p 

    for (var i=0; i<self.peers.length; i++) {
      if (self.peers[i].id === data.id) {
        self._onLostPeer(self.peers[i])
        self.peers.splice(i, 1)
        break
      }
    }
    if (data.nop2p) self.mustForward--
  })
  
  self._socket.on('id', function (id) {
    if (self.id) return
    self.id = id
    self.events('id', self.id)
    self.setUserId(id)
    
    self._socket.emit('join', {
      room: self.room,
      nickname: self.nickname,
      nop2p: self.nop2p
    })
  })
}

Connector.prototype._setupP2P = function (room, nickname) {
  var self = this
  
  self._client = new SimpleSignalClient(self._socket, {
    room: self.room
  })
  
  self._client.on('ready', function (peerIDs) {   

    self.events('voice', {
      client: self._client,
      socket: self._socket
    })
    
    if (!self.id) {
      self.setUserId(self._client.id)
      self.id = self._client.id
      self.events('id', self.id)
    }
    
    for (var i=0; i<peerIDs.length; i++) {
      if (peerIDs[i] === self._client.id) continue
      self._client.connect(peerIDs[i], {wrtc:self.wrtc}, {
        nickname: self.nickname
      })
    }
  })
  
  self._client.on('request', function (request) {
    if (request.metadata.voice) return
    request.accept({wrtc:self.wrtc}, {
      nickname: self.nickname
    })
  })
  
  self._client.on('peer', function (peer) {
    if (peer.metadata.voice) return
    peer.metadata.nickname = peer.metadata.nickname || 'Guest'

    // throttle outgoing
    var throttle = new Throttle({rate:300*1000, chunksize: 15*1000})
    peer.wire = new Wire()
    peer.pipe(peer.wire).pipe(throttle).pipe(peer)
    
    self.peers.push(peer)

    peer.wire.on('yjs', function (message) {
      if (peer.connected)  {
        self.receiveMessage(peer.id, message)
      } else {
        if (!peer.destroyed) {
          self.queue.push({
            id: peer.id,
            message: message
          })
        }
      }
    })

    peer.on('connect', function () {
      self._onGotPeer(peer)
      self.queue.forEach(function (a) {
        if (a.id === peer.id) {
          self.receiveMessage(a.id, a.message)
        }
      })
    }) 
    
    peer.on('close', function () {
      console.warn('connection to peer closed')
      self._destroyPeer(peer)
    })
    
    
  })
}

Connector.prototype._destroyPeer = function (peer) {
  var self = this
  
  for (var i=0; i<self.peers.length; i++) {
    if (self.peers[i].id === peer.id) {
      self.peers.splice(i, 1)
      break
    }
  }
  peer.destroy()
  self._onLostPeer(peer)
}

Connector.prototype._sendAllPeers = function (event, message) {
  var self = this
  
  if (self.nop2p || self.mustForward > 0) {
    self._socket.emit('forward', {
      event: event,
      target: self.room,
      message: message
    })
    return
  }

  for (var i=0; i<self.peers.length; i++) {
    if (!self.peers[i].nop2p) {
      self.peers[i].wire[event](message)
    }
  }
}

Connector.prototype._sendOnePeer = function (id, event, message) {
  var self = this
  
  if (self.nop2p) {
    self._socket.emit('forward', {
      target: id,
      event: event,
      message: message
    })
    return
  }
  
  for (var i=0; i<self.peers.length; i++) {
    if (self.peers[i].id !== id) continue
    if (self.peers[i].nop2p) {
      self._socket.emit('forward', {
        event: event,
        message: message
      })
    } else {
      self.peers[i].wire[event](message)
    }
    break
  }
}

Connector.prototype._onGotPeer = function (peer) {
  var self = this
  
  self.events('peers', self.peers)
  self.events('gotPeer', peer)
  self.userJoined(peer.id, 'master')
}

Connector.prototype._onLostPeer = function (peer) {
  var self = this
  
  self.events('peers', self.peers)
  self.events('lostPeer', peer)
  self.userLeft(peer.id)
}

Connector.prototype.disconnect = function () {
  var self = this
  
  for (var i=0; i<self.peers.length; i++) {
    if (self.peers[i].nop2p || self.nop2p) {
      self.peers[i] = null
    } else {
      self.peers[i].destroy()
    }
  }
  
  self.voice = null
  self._client = null
  self.nop2p = null
  self.peers = null
  self._handlers = null
  self._socket.disconnect()
  self._socket = null
}

Connector.prototype.reconnect = function () {
  var self = this
  
  self._socket = new Io(self.hostname)
  self.peers = []
  self.mustForward = 0 // num of peers that are nop2p

  self._setupSocket()
  
  if (!getBrowserRTC()) {
    console.warn('No WebRTC support')
    self.nop2p = true
  } else {
    self.nop2p = false
    self._setupP2P()
  }
}

Connector.prototype.sendMeta = function (id, event, message) {
  var self = this
  if (event === 'yjs') throw new Error('Metadata cannot use the "yjs" event!')
  self._sendOnePeer(id, event, message)
}

// only yjs should call this!
Connector.prototype.send = function (id, message) {
  var self = this
  self._sendOnePeer(id, 'yjs', message)
}

Connector.prototype.broadcast = function (message) {
  var self = this
  self._sendAllPeers('yjs', message)
}

Connector.prototype.isDisconnected = function () {
  return false
}

function extend (Y) {
  Y.extend('multihack', Connector)
}

module.exports = extend
if (typeof Y !== 'undefined') {
  extend(Y)
}
