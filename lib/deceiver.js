var assert = require('assert')
var Buffer = require('buffer').Buffer
var IncomingMessage = require('http').IncomingMessage
var kIncomingMessage = require('_http_common').kIncomingMessage

var HTTPParser

var methods
var reverseMethods

// var kOnHeaders
var kOnHeadersComplete
var kOnMessageComplete
var kOnBody

HTTPParser = process.binding('http_parser').HTTPParser
methods = process.binding('http_parser').methods

reverseMethods = {}

methods.forEach(function (method, index) {
  reverseMethods[method] = index
})

// kOnHeaders = HTTPParser.kOnHeaders | 0
kOnHeadersComplete = HTTPParser.kOnHeadersComplete | 0
kOnMessageComplete = HTTPParser.kOnMessageComplete | 0
kOnBody = HTTPParser.kOnBody | 0

function Deceiver (socket, options) {
  this.socket = socket
  this.options = options || {}
  this.isClient = this.options.isClient
}
module.exports = Deceiver

Deceiver.create = function create (stream, options) {
  return new Deceiver(stream, options)
}

Deceiver.prototype._toHeaderList = function _toHeaderList (object) {
  var out = []
  var keys = Object.keys(object)

  for (var i = 0; i < keys.length; i++) {
    out.push(keys[i], object[keys[i]])
  }

  return out
}

Deceiver.prototype._isUpgrade = function _isUpgrade (request) {
  return request.method === 'CONNECT' ||
         !!request.headers.upgrade ||
         (request.headers.connection &&
            /(^|\W)upgrade(\W|$)/i.test(request.headers.connection))
}

// TODO(indutny): support CONNECT
function parserOnHeadersComplete (versionMajor, versionMinor, headers, method,
  url, statusCode, statusMessage, upgrade, shouldKeepAlive) {
  const parser = this
  const { socket } = parser

  if (headers === undefined) {
    headers = parser._headers
    parser._headers = []
  }

  if (url === undefined) {
    url = parser._url
    parser._url = ''
  }

  // Parser is also used by http client
  const ParserIncomingMessage = (socket && socket.server &&
    socket.server[kIncomingMessage]) ||
    IncomingMessage

  const incoming = parser.incoming = new ParserIncomingMessage(socket)
  incoming.httpVersionMajor = versionMajor
  incoming.httpVersionMinor = versionMinor
  incoming.httpVersion = `${versionMajor}.${versionMinor}`
  incoming.url = url
  incoming.upgrade = upgrade

  var n = headers.length

  // If parser.maxHeaderPairs <= 0 assume that there's no limit.
  if (parser.maxHeaderPairs > 0) { n = Math.min(n, parser.maxHeaderPairs) }

  incoming._addHeaderLines(headers, n)

  if (typeof method === 'number') {
  // server only
    incoming.method = methods[method]
  } else {
  // client only
    incoming.statusCode = statusCode
    incoming.statusMessage = statusMessage
  }

  return parser.onIncoming(incoming, shouldKeepAlive)
}

Deceiver.prototype.emitRequest = function emitRequest (request) {
  var parser = this.socket.parser
  assert(parser, 'No parser present')

  parser.execute = null

  var self = this
  var method = reverseMethods[request.method]
  parser.execute = function execute () {
    self._skipExecute(this)
    parserOnHeadersComplete.call(this, 1,
      1,
      self._toHeaderList(request.headers),
      method,
      request.path,
      0,
      '',
      self._isUpgrade(request),
      true)

    return 0
  }

  this._emitEmpty()
}

Deceiver.prototype.emitResponse = function emitResponse (response) {
  var parser = this.socket.parser
  assert(parser, 'No parser present')

  parser.execute = null

  var self = this
  parser.execute = function execute () {
    self._skipExecute(this)
    this[kOnHeadersComplete](1,
      1,
      self._toHeaderList(response.headers),
      response.path,
      response.code,
      response.status,
      response.reason || '',
      self._isUpgrade(response),
      true)
    return 0
  }

  this._emitEmpty()
}

Deceiver.prototype._skipExecute = function _skipExecute (parser) {
  var self = this
  var oldExecute = parser.constructor.prototype.execute
  var oldFinish = parser.constructor.prototype.finish

  parser.execute = null
  parser.finish = null

  parser.execute = function execute (buffer, start, len) {
    // Parser reuse
    if (this.socket !== self.socket) {
      this.execute = oldExecute
      this.finish = oldFinish
      return this.execute(buffer, start, len)
    }

    if (start !== undefined) {
      buffer = buffer.slice(start, start + len)
    }
    self.emitBody(buffer)
    return len
  }

  parser.finish = function finish () {
    // Parser reuse
    if (this.socket !== self.socket) {
      this.execute = oldExecute
      this.finish = oldFinish
      return this.finish()
    }

    this.execute = oldExecute
    this.finish = oldFinish
    self.emitMessageComplete()
  }
}

Deceiver.prototype.emitBody = function emitBody (buffer) {
  var parser = this.socket.parser
  assert(parser, 'No parser present')

  parser[kOnBody](buffer, 0, buffer.length)
}

Deceiver.prototype._emitEmpty = function _emitEmpty () {
  // Emit data to force out handling of UPGRADE
  var empty = Buffer.alloc(0)
  if (this.socket.ondata) { this.socket.ondata(empty, 0, 0) } else {
    this.socket.emit('data', empty)
  }
}

Deceiver.prototype.emitMessageComplete = function emitMessageComplete () {
  var parser = this.socket.parser
  assert(parser, 'No parser present')

  parser[kOnMessageComplete]()
}
