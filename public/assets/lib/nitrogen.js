// Browser Request
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var XHR = XMLHttpRequest
if (!XHR) throw new Error('missing XMLHttpRequest')

request.log = {
  'trace': noop, 'debug': noop, 'info': noop, 'warn': noop, 'error': noop
}

var DEFAULT_TIMEOUT = 3 * 60 * 1000 // 3 minutes

//
// request
//

function request(options, callback) {
  // The entry-point to the API: prep the options object and pass the real work to run_xhr.
  if(typeof callback !== 'function')
    throw new Error('Bad callback given: ' + callback)

  if(!options)
    throw new Error('No options given')

  var options_onResponse = options.onResponse; // Save this for later.

  if(typeof options === 'string')
    options = {'uri':options};
  else
    options = JSON.parse(JSON.stringify(options)); // Use a duplicate for mutating.

  options.onResponse = options_onResponse // And put it back.

  if (options.verbose) request.log = getLogger();

  if(options.url) {
    options.uri = options.url;
    delete options.url;
  }

  if(!options.uri && options.uri !== "")
    throw new Error("options.uri is a required argument");

  if(typeof options.uri != "string")
    throw new Error("options.uri must be a string");

  var unsupported_options = ['proxy', '_redirectsFollowed', 'maxRedirects', 'followRedirect']
  for (var i = 0; i < unsupported_options.length; i++)
    if(options[ unsupported_options[i] ])
      throw new Error("options." + unsupported_options[i] + " is not supported")

  options.callback = callback
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body    = options.body || null
  options.timeout = options.timeout || request.DEFAULT_TIMEOUT

  if(options.headers.host)
    throw new Error("Options.headers.host is not supported");

  if(options.json) {
    options.headers.accept = options.headers.accept || 'application/json'
    if(options.method !== 'GET')
      options.headers['content-type'] = 'application/json'

    if(typeof options.json !== 'boolean')
      options.body = JSON.stringify(options.json)
    else if(typeof options.body !== 'string')
      options.body = JSON.stringify(options.body)
  }

  // If onResponse is boolean true, call back immediately when the response is known,
  // not when the full request is complete.
  options.onResponse = options.onResponse || noop
  if(options.onResponse === true) {
    options.onResponse = callback
    options.callback = noop
  }

  // XXX Browsers do not like this.
  //if(options.body)
  //  options.headers['content-length'] = options.body.length;

  // HTTP basic authentication
  if(!options.headers.authorization && options.auth)
    options.headers.authorization = 'Basic ' + b64_enc(options.auth.username + ':' + options.auth.password);

  return run_xhr(options)
}

var req_seq = 0
function run_xhr(options) {
  var xhr = new XHR
    , timed_out = false
    , is_cors = is_crossDomain(options.uri)
    , supports_cors = ('withCredentials' in xhr)

  req_seq += 1
  xhr.seq_id = req_seq
  xhr.id = req_seq + ': ' + options.method + ' ' + options.uri
  xhr._id = xhr.id // I know I will type "_id" from habit all the time.

  if(is_cors && !supports_cors) {
    var cors_err = new Error('Browser does not support cross-origin request: ' + options.uri)
    cors_err.cors = 'unsupported'
    return options.callback(cors_err, xhr)
  }

  xhr.timeoutTimer = setTimeout(too_late, options.timeout)
  function too_late() {
    timed_out = true
    var er = new Error('ETIMEDOUT')
    er.code = 'ETIMEDOUT'
    er.duration = options.timeout

    request.log.error('Timeout', { 'id':xhr._id, 'milliseconds':options.timeout })
    return options.callback(er, xhr)
  }

  // Some states can be skipped over, so remember what is still incomplete.
  var did = {'response':false, 'loading':false, 'end':false}

  xhr.onreadystatechange = on_state_change
  xhr.open(options.method, options.uri, true) // asynchronous
  if(is_cors)
    xhr.withCredentials = !! options.withCredentials
  xhr.send(options.body)
  return xhr

  function on_state_change(event) {
    if(timed_out)
      return request.log.debug('Ignoring timed out state change', {'state':xhr.readyState, 'id':xhr.id})

    request.log.debug('State change', {'state':xhr.readyState, 'id':xhr.id, 'timed_out':timed_out})

    if(xhr.readyState === XHR.OPENED) {
      request.log.debug('Request started', {'id':xhr.id})
      try {
      for (var key in options.headers)
         xhr.setRequestHeader(key, options.headers[key])
      } catch (anException) {}
    }

    else if(xhr.readyState === XHR.HEADERS_RECEIVED)
      on_response()

    else if(xhr.readyState === XHR.LOADING) {
      on_response()
      on_loading()
    }

    else if(xhr.readyState === XHR.DONE) {
      on_response()
      on_loading()
      on_end()
    }
  }

  function on_response() {
    if(did.response)
      return

    did.response = true
    request.log.debug('Got response', {'id':xhr.id, 'status':xhr.status})
    clearTimeout(xhr.timeoutTimer)
    xhr.statusCode = xhr.status // Node request compatibility

    // Detect failed CORS requests.
    if(is_cors && xhr.statusCode == 0) {
      var cors_err = new Error('CORS request rejected: ' + options.uri)
      cors_err.cors = 'rejected'

      // Do not process this request further.
      did.loading = true
      did.end = true

      return options.callback(cors_err, xhr)
    }

    options.onResponse(null, xhr)
  }

  function on_loading() {
    if(did.loading)
      return

    did.loading = true
    request.log.debug('Response body loading', {'id':xhr.id})
    // TODO: Maybe simulate "data" events by watching xhr.responseText
  }

  function on_end() {
    if(did.end)
      return

    did.end = true
    request.log.debug('Request done', {'id':xhr.id})

    xhr.body = xhr.responseText
    if(options.json) {
      try        { xhr.body = JSON.parse(xhr.responseText) }
      catch (er) { return options.callback(er, xhr)        }
    }

    options.callback(null, xhr, xhr.body)
  }

} // request

request.withCredentials = false;
request.DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

//
// defaults
//

request.defaults = function(options, requester) {
  var def = function (method) {
    var d = function (params, callback) {
      if(typeof params === 'string')
        params = {'uri': params};
      else {
        params = JSON.parse(JSON.stringify(params));
      }
      for (var i in options) {
        if (params[i] === undefined) params[i] = options[i]
      }
      return method(params, callback)
    }
    return d
  }
  var de = def(request)
  de.get = def(request.get)
  de.post = def(request.post)
  de.put = def(request.put)
  de.head = def(request.head)
  return de
}

//
// HTTP method shortcuts
//

var shortcuts = [ 'get', 'put', 'post', 'head', 'del' ];
var shortcutToMethod = { 'del' : 'DELETE' };
shortcuts.forEach(function(shortcut) {
  var method = shortcutToMethod[shortcut] || shortcut.toUpperCase();
  var func   = shortcut.toLowerCase();

  request[func] = function(opts) {
    if(typeof opts === 'string')
      opts = {'method':method, 'uri':opts};
    else {
      opts = JSON.parse(JSON.stringify(opts));
      opts.method = method;
    }

    var args = [opts].concat(Array.prototype.slice.apply(arguments, [1]));
    return request.apply(this, args);
  }
})

//
// Utility
//

function noop() {}

function getLogger() {
  var logger = {}
    , levels = ['trace', 'debug', 'info', 'warn', 'error']
    , level, i

  for(i = 0; i < levels.length; i++) {
    level = levels[i]

    logger[level] = noop
    if(typeof console !== 'undefined' && console && console[level])
      logger[level] = formatted(console, level)
  }

  return logger
}

function formatted(obj, method) {
  return formatted_logger

  function formatted_logger(str, context) {
    if(typeof context === 'object')
      str += ' ' + JSON.stringify(context)

    return obj[method].call(obj, str)
  }
}

// Return whether a URL is a cross-domain request.
function is_crossDomain(url) {
  var rurl = /^([\w\+\.\-]+:)(?:\/\/([^\/?#:]*)(?::(\d+))?)?/

  // jQuery #8138, IE may throw an exception when accessing
  // a field from window.location if document.domain has been set
  var ajaxLocation
  try { ajaxLocation = location.href }
  catch (e) {
    // Use the href attribute of an A element since IE will modify it given document.location
    ajaxLocation = document.createElement( "a" );
    ajaxLocation.href = "";
    ajaxLocation = ajaxLocation.href;
  }

  var ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || []
    , parts = rurl.exec(url.toLowerCase() )

  var result = !!(
    parts &&
    (  parts[1] != ajaxLocParts[1]
    || parts[2] != ajaxLocParts[2]
    || (parts[3] || (parts[1] === "http:" ? 80 : 443)) != (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? 80 : 443))
    )
  )

  //console.debug('is_crossDomain('+url+') -> ' + result)
  return result
}

// MIT License from http://phpjs.org/functions/base64_encode:358
function b64_enc (data) {
    // Encodes string using MIME base64 algorithm
    var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    var o1, o2, o3, h1, h2, h3, h4, bits, i = 0, ac = 0, enc="", tmp_arr = [];

    if (!data) {
        return data;
    }

    // assume utf8 data
    // data = this.utf8_encode(data+'');

    do { // pack three octets into four hexets
        o1 = data.charCodeAt(i++);
        o2 = data.charCodeAt(i++);
        o3 = data.charCodeAt(i++);

        bits = o1<<16 | o2<<8 | o3;

        h1 = bits>>18 & 0x3f;
        h2 = bits>>12 & 0x3f;
        h3 = bits>>6 & 0x3f;
        h4 = bits & 0x3f;

        // use hexets to index into b64, and append result to encoded string
        tmp_arr[ac++] = b64.charAt(h1) + b64.charAt(h2) + b64.charAt(h3) + b64.charAt(h4);
    } while (i < data.length);

    enc = tmp_arr.join('');

    switch (data.length % 3) {
        case 1:
            enc = enc.slice(0, -2) + '==';
        break;
        case 2:
            enc = enc.slice(0, -1) + '=';
        break;
    }

    return enc;
}
/*! Socket.IO.js build:0.9.17, development. Copyright(c) 2011 LearnBoost <dev@learnboost.com> MIT Licensed */

var io = ('undefined' === typeof module ? {} : module.exports);
(function() {

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, global) {

  /**
   * IO namespace.
   *
   * @namespace
   */

  var io = exports;

  /**
   * Socket.IO version
   *
   * @api public
   */

  io.version = '0.9.17';

  /**
   * Protocol implemented.
   *
   * @api public
   */

  io.protocol = 1;

  /**
   * Available transports, these will be populated with the available transports
   *
   * @api public
   */

  io.transports = [];

  /**
   * Keep track of jsonp callbacks.
   *
   * @api private
   */

  io.j = [];

  /**
   * Keep track of our io.Sockets
   *
   * @api private
   */
  io.sockets = {};


  /**
   * Manages connections to hosts.
   *
   * @param {String} uri
   * @Param {Boolean} force creation of new socket (defaults to false)
   * @api public
   */

  io.connect = function (host, details) {
    var uri = io.util.parseUri(host)
      , uuri
      , socket;

    if (global && global.location) {
      uri.protocol = uri.protocol || global.location.protocol.slice(0, -1);
      uri.host = uri.host || (global.document
        ? global.document.domain : global.location.hostname);
      uri.port = uri.port || global.location.port;
    }

    uuri = io.util.uniqueUri(uri);

    var options = {
        host: uri.host
      , secure: 'https' == uri.protocol
      , port: uri.port || ('https' == uri.protocol ? 443 : 80)
      , query: uri.query || ''
    };

    io.util.merge(options, details);

    if (options['force new connection'] || !io.sockets[uuri]) {
      socket = new io.Socket(options);
    }

    if (!options['force new connection'] && socket) {
      io.sockets[uuri] = socket;
    }

    socket = socket || io.sockets[uuri];

    // if path is different from '' or /
    return socket.of(uri.path.length > 1 ? uri.path : '');
  };

})('object' === typeof module ? module.exports : (this.io = {}), this);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, global) {

  /**
   * Utilities namespace.
   *
   * @namespace
   */

  var util = exports.util = {};

  /**
   * Parses an URI
   *
   * @author Steven Levithan <stevenlevithan.com> (MIT license)
   * @api public
   */

  var re = /^(?:(?![^:@]+:[^:@\/]*@)([^:\/?#.]+):)?(?:\/\/)?((?:(([^:@]*)(?::([^:@]*))?)?@)?([^:\/?#]*)(?::(\d*))?)(((\/(?:[^?#](?![^?#\/]*\.[^?#\/.]+(?:[?#]|$)))*\/?)?([^?#\/]*))(?:\?([^#]*))?(?:#(.*))?)/;

  var parts = ['source', 'protocol', 'authority', 'userInfo', 'user', 'password',
               'host', 'port', 'relative', 'path', 'directory', 'file', 'query',
               'anchor'];

  util.parseUri = function (str) {
    var m = re.exec(str || '')
      , uri = {}
      , i = 14;

    while (i--) {
      uri[parts[i]] = m[i] || '';
    }

    return uri;
  };

  /**
   * Produces a unique url that identifies a Socket.IO connection.
   *
   * @param {Object} uri
   * @api public
   */

  util.uniqueUri = function (uri) {
    var protocol = uri.protocol
      , host = uri.host
      , port = uri.port;

    if ('document' in global) {
      host = host || document.domain;
      port = port || (protocol == 'https'
        && document.location.protocol !== 'https:' ? 443 : document.location.port);
    } else {
      host = host || 'localhost';

      if (!port && protocol == 'https') {
        port = 443;
      }
    }

    return (protocol || 'http') + '://' + host + ':' + (port || 80);
  };

  /**
   * Mergest 2 query strings in to once unique query string
   *
   * @param {String} base
   * @param {String} addition
   * @api public
   */

  util.query = function (base, addition) {
    var query = util.chunkQuery(base || '')
      , components = [];

    util.merge(query, util.chunkQuery(addition || ''));
    for (var part in query) {
      if (query.hasOwnProperty(part)) {
        components.push(part + '=' + query[part]);
      }
    }

    return components.length ? '?' + components.join('&') : '';
  };

  /**
   * Transforms a querystring in to an object
   *
   * @param {String} qs
   * @api public
   */

  util.chunkQuery = function (qs) {
    var query = {}
      , params = qs.split('&')
      , i = 0
      , l = params.length
      , kv;

    for (; i < l; ++i) {
      kv = params[i].split('=');
      if (kv[0]) {
        query[kv[0]] = kv[1];
      }
    }

    return query;
  };

  /**
   * Executes the given function when the page is loaded.
   *
   *     io.util.load(function () { console.log('page loaded'); });
   *
   * @param {Function} fn
   * @api public
   */

  var pageLoaded = false;

  util.load = function (fn) {
    if ('document' in global && document.readyState === 'complete' || pageLoaded) {
      return fn();
    }

    util.on(global, 'load', fn, false);
  };

  /**
   * Adds an event.
   *
   * @api private
   */

  util.on = function (element, event, fn, capture) {
    if (element.attachEvent) {
      element.attachEvent('on' + event, fn);
    } else if (element.addEventListener) {
      element.addEventListener(event, fn, capture);
    }
  };

  /**
   * Generates the correct `XMLHttpRequest` for regular and cross domain requests.
   *
   * @param {Boolean} [xdomain] Create a request that can be used cross domain.
   * @returns {XMLHttpRequest|false} If we can create a XMLHttpRequest.
   * @api private
   */

  util.request = function (xdomain) {

    if (xdomain && 'undefined' != typeof XDomainRequest && !util.ua.hasCORS) {
      return new XDomainRequest();
    }

    if ('undefined' != typeof XMLHttpRequest && (!xdomain || util.ua.hasCORS)) {
      return new XMLHttpRequest();
    }

    if (!xdomain) {
      try {
        return new window[(['Active'].concat('Object').join('X'))]('Microsoft.XMLHTTP');
      } catch(e) { }
    }

    return null;
  };

  /**
   * XHR based transport constructor.
   *
   * @constructor
   * @api public
   */

  /**
   * Change the internal pageLoaded value.
   */

  if ('undefined' != typeof window) {
    util.load(function () {
      pageLoaded = true;
    });
  }

  /**
   * Defers a function to ensure a spinner is not displayed by the browser
   *
   * @param {Function} fn
   * @api public
   */

  util.defer = function (fn) {
    if (!util.ua.webkit || 'undefined' != typeof importScripts) {
      return fn();
    }

    util.load(function () {
      setTimeout(fn, 100);
    });
  };

  /**
   * Merges two objects.
   *
   * @api public
   */

  util.merge = function merge (target, additional, deep, lastseen) {
    var seen = lastseen || []
      , depth = typeof deep == 'undefined' ? 2 : deep
      , prop;

    for (prop in additional) {
      if (additional.hasOwnProperty(prop) && util.indexOf(seen, prop) < 0) {
        if (typeof target[prop] !== 'object' || !depth) {
          target[prop] = additional[prop];
          seen.push(additional[prop]);
        } else {
          util.merge(target[prop], additional[prop], depth - 1, seen);
        }
      }
    }

    return target;
  };

  /**
   * Merges prototypes from objects
   *
   * @api public
   */

  util.mixin = function (ctor, ctor2) {
    util.merge(ctor.prototype, ctor2.prototype);
  };

  /**
   * Shortcut for prototypical and static inheritance.
   *
   * @api private
   */

  util.inherit = function (ctor, ctor2) {
    function f() {};
    f.prototype = ctor2.prototype;
    ctor.prototype = new f;
  };

  /**
   * Checks if the given object is an Array.
   *
   *     io.util.isArray([]); // true
   *     io.util.isArray({}); // false
   *
   * @param Object obj
   * @api public
   */

  util.isArray = Array.isArray || function (obj) {
    return Object.prototype.toString.call(obj) === '[object Array]';
  };

  /**
   * Intersects values of two arrays into a third
   *
   * @api public
   */

  util.intersect = function (arr, arr2) {
    var ret = []
      , longest = arr.length > arr2.length ? arr : arr2
      , shortest = arr.length > arr2.length ? arr2 : arr;

    for (var i = 0, l = shortest.length; i < l; i++) {
      if (~util.indexOf(longest, shortest[i]))
        ret.push(shortest[i]);
    }

    return ret;
  };

  /**
   * Array indexOf compatibility.
   *
   * @see bit.ly/a5Dxa2
   * @api public
   */

  util.indexOf = function (arr, o, i) {

    for (var j = arr.length, i = i < 0 ? i + j < 0 ? 0 : i + j : i || 0;
         i < j && arr[i] !== o; i++) {}

    return j <= i ? -1 : i;
  };

  /**
   * Converts enumerables to array.
   *
   * @api public
   */

  util.toArray = function (enu) {
    var arr = [];

    for (var i = 0, l = enu.length; i < l; i++)
      arr.push(enu[i]);

    return arr;
  };

  /**
   * UA / engines detection namespace.
   *
   * @namespace
   */

  util.ua = {};

  /**
   * Whether the UA supports CORS for XHR.
   *
   * @api public
   */

  util.ua.hasCORS = 'undefined' != typeof XMLHttpRequest && (function () {
    try {
      var a = new XMLHttpRequest();
    } catch (e) {
      return false;
    }

    return a.withCredentials != undefined;
  })();

  /**
   * Detect webkit.
   *
   * @api public
   */

  util.ua.webkit = 'undefined' != typeof navigator
    && /webkit/i.test(navigator.userAgent);

   /**
   * Detect iPad/iPhone/iPod.
   *
   * @api public
   */

  util.ua.iDevice = 'undefined' != typeof navigator
      && /iPad|iPhone|iPod/i.test(navigator.userAgent);

})('undefined' != typeof io ? io : module.exports, this);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Expose constructor.
   */

  exports.EventEmitter = EventEmitter;

  /**
   * Event emitter constructor.
   *
   * @api public.
   */

  function EventEmitter () {};

  /**
   * Adds a listener
   *
   * @api public
   */

  EventEmitter.prototype.on = function (name, fn) {
    if (!this.$events) {
      this.$events = {};
    }

    if (!this.$events[name]) {
      this.$events[name] = fn;
    } else if (io.util.isArray(this.$events[name])) {
      this.$events[name].push(fn);
    } else {
      this.$events[name] = [this.$events[name], fn];
    }

    return this;
  };

  EventEmitter.prototype.addListener = EventEmitter.prototype.on;

  /**
   * Adds a volatile listener.
   *
   * @api public
   */

  EventEmitter.prototype.once = function (name, fn) {
    var self = this;

    function on () {
      self.removeListener(name, on);
      fn.apply(this, arguments);
    };

    on.listener = fn;
    this.on(name, on);

    return this;
  };

  /**
   * Removes a listener.
   *
   * @api public
   */

  EventEmitter.prototype.removeListener = function (name, fn) {
    if (this.$events && this.$events[name]) {
      var list = this.$events[name];

      if (io.util.isArray(list)) {
        var pos = -1;

        for (var i = 0, l = list.length; i < l; i++) {
          if (list[i] === fn || (list[i].listener && list[i].listener === fn)) {
            pos = i;
            break;
          }
        }

        if (pos < 0) {
          return this;
        }

        list.splice(pos, 1);

        if (!list.length) {
          delete this.$events[name];
        }
      } else if (list === fn || (list.listener && list.listener === fn)) {
        delete this.$events[name];
      }
    }

    return this;
  };

  /**
   * Removes all listeners for an event.
   *
   * @api public
   */

  EventEmitter.prototype.removeAllListeners = function (name) {
    if (name === undefined) {
      this.$events = {};
      return this;
    }

    if (this.$events && this.$events[name]) {
      this.$events[name] = null;
    }

    return this;
  };

  /**
   * Gets all listeners for a certain event.
   *
   * @api publci
   */

  EventEmitter.prototype.listeners = function (name) {
    if (!this.$events) {
      this.$events = {};
    }

    if (!this.$events[name]) {
      this.$events[name] = [];
    }

    if (!io.util.isArray(this.$events[name])) {
      this.$events[name] = [this.$events[name]];
    }

    return this.$events[name];
  };

  /**
   * Emits an event.
   *
   * @api public
   */

  EventEmitter.prototype.emit = function (name) {
    if (!this.$events) {
      return false;
    }

    var handler = this.$events[name];

    if (!handler) {
      return false;
    }

    var args = Array.prototype.slice.call(arguments, 1);

    if ('function' == typeof handler) {
      handler.apply(this, args);
    } else if (io.util.isArray(handler)) {
      var listeners = handler.slice();

      for (var i = 0, l = listeners.length; i < l; i++) {
        listeners[i].apply(this, args);
      }
    } else {
      return false;
    }

    return true;
  };

})(
    'undefined' != typeof io ? io : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

/**
 * Based on JSON2 (http://www.JSON.org/js.html).
 */

(function (exports, nativeJSON) {
  "use strict";

  // use native JSON if it's available
  if (nativeJSON && nativeJSON.parse){
    return exports.JSON = {
      parse: nativeJSON.parse
    , stringify: nativeJSON.stringify
    };
  }

  var JSON = exports.JSON = {};

  function f(n) {
      // Format integers to have at least two digits.
      return n < 10 ? '0' + n : n;
  }

  function date(d, key) {
    return isFinite(d.valueOf()) ?
        d.getUTCFullYear()     + '-' +
        f(d.getUTCMonth() + 1) + '-' +
        f(d.getUTCDate())      + 'T' +
        f(d.getUTCHours())     + ':' +
        f(d.getUTCMinutes())   + ':' +
        f(d.getUTCSeconds())   + 'Z' : null;
  };

  var cx = /[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
      escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g,
      gap,
      indent,
      meta = {    // table of character substitutions
          '\b': '\\b',
          '\t': '\\t',
          '\n': '\\n',
          '\f': '\\f',
          '\r': '\\r',
          '"' : '\\"',
          '\\': '\\\\'
      },
      rep;


  function quote(string) {

// If the string contains no control characters, no quote characters, and no
// backslash characters, then we can safely slap some quotes around it.
// Otherwise we must also replace the offending characters with safe escape
// sequences.

      escapable.lastIndex = 0;
      return escapable.test(string) ? '"' + string.replace(escapable, function (a) {
          var c = meta[a];
          return typeof c === 'string' ? c :
              '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
      }) + '"' : '"' + string + '"';
  }


  function str(key, holder) {

// Produce a string from holder[key].

      var i,          // The loop counter.
          k,          // The member key.
          v,          // The member value.
          length,
          mind = gap,
          partial,
          value = holder[key];

// If the value has a toJSON method, call it to obtain a replacement value.

      if (value instanceof Date) {
          value = date(key);
      }

// If we were called with a replacer function, then call the replacer to
// obtain a replacement value.

      if (typeof rep === 'function') {
          value = rep.call(holder, key, value);
      }

// What happens next depends on the value's type.

      switch (typeof value) {
      case 'string':
          return quote(value);

      case 'number':

// JSON numbers must be finite. Encode non-finite numbers as null.

          return isFinite(value) ? String(value) : 'null';

      case 'boolean':
      case 'null':

// If the value is a boolean or null, convert it to a string. Note:
// typeof null does not produce 'null'. The case is included here in
// the remote chance that this gets fixed someday.

          return String(value);

// If the type is 'object', we might be dealing with an object or an array or
// null.

      case 'object':

// Due to a specification blunder in ECMAScript, typeof null is 'object',
// so watch out for that case.

          if (!value) {
              return 'null';
          }

// Make an array to hold the partial results of stringifying this object value.

          gap += indent;
          partial = [];

// Is the value an array?

          if (Object.prototype.toString.apply(value) === '[object Array]') {

// The value is an array. Stringify every element. Use null as a placeholder
// for non-JSON values.

              length = value.length;
              for (i = 0; i < length; i += 1) {
                  partial[i] = str(i, value) || 'null';
              }

// Join all of the elements together, separated with commas, and wrap them in
// brackets.

              v = partial.length === 0 ? '[]' : gap ?
                  '[\n' + gap + partial.join(',\n' + gap) + '\n' + mind + ']' :
                  '[' + partial.join(',') + ']';
              gap = mind;
              return v;
          }

// If the replacer is an array, use it to select the members to be stringified.

          if (rep && typeof rep === 'object') {
              length = rep.length;
              for (i = 0; i < length; i += 1) {
                  if (typeof rep[i] === 'string') {
                      k = rep[i];
                      v = str(k, value);
                      if (v) {
                          partial.push(quote(k) + (gap ? ': ' : ':') + v);
                      }
                  }
              }
          } else {

// Otherwise, iterate through all of the keys in the object.

              for (k in value) {
                  if (Object.prototype.hasOwnProperty.call(value, k)) {
                      v = str(k, value);
                      if (v) {
                          partial.push(quote(k) + (gap ? ': ' : ':') + v);
                      }
                  }
              }
          }

// Join all of the member texts together, separated with commas,
// and wrap them in braces.

          v = partial.length === 0 ? '{}' : gap ?
              '{\n' + gap + partial.join(',\n' + gap) + '\n' + mind + '}' :
              '{' + partial.join(',') + '}';
          gap = mind;
          return v;
      }
  }

// If the JSON object does not yet have a stringify method, give it one.

  JSON.stringify = function (value, replacer, space) {

// The stringify method takes a value and an optional replacer, and an optional
// space parameter, and returns a JSON text. The replacer can be a function
// that can replace values, or an array of strings that will select the keys.
// A default replacer method can be provided. Use of the space parameter can
// produce text that is more easily readable.

      var i;
      gap = '';
      indent = '';

// If the space parameter is a number, make an indent string containing that
// many spaces.

      if (typeof space === 'number') {
          for (i = 0; i < space; i += 1) {
              indent += ' ';
          }

// If the space parameter is a string, it will be used as the indent string.

      } else if (typeof space === 'string') {
          indent = space;
      }

// If there is a replacer, it must be a function or an array.
// Otherwise, throw an error.

      rep = replacer;
      if (replacer && typeof replacer !== 'function' &&
              (typeof replacer !== 'object' ||
              typeof replacer.length !== 'number')) {
          throw new Error('JSON.stringify');
      }

// Make a fake root object containing our value under the key of ''.
// Return the result of stringifying the value.

      return str('', {'': value});
  };

// If the JSON object does not yet have a parse method, give it one.

  JSON.parse = function (text, reviver) {
  // The parse method takes a text and an optional reviver function, and returns
  // a JavaScript value if the text is a valid JSON text.

      var j;

      function walk(holder, key) {

  // The walk method is used to recursively walk the resulting structure so
  // that modifications can be made.

          var k, v, value = holder[key];
          if (value && typeof value === 'object') {
              for (k in value) {
                  if (Object.prototype.hasOwnProperty.call(value, k)) {
                      v = walk(value, k);
                      if (v !== undefined) {
                          value[k] = v;
                      } else {
                          delete value[k];
                      }
                  }
              }
          }
          return reviver.call(holder, key, value);
      }


  // Parsing happens in four stages. In the first stage, we replace certain
  // Unicode characters with escape sequences. JavaScript handles many characters
  // incorrectly, either silently deleting them, or treating them as line endings.

      text = String(text);
      cx.lastIndex = 0;
      if (cx.test(text)) {
          text = text.replace(cx, function (a) {
              return '\\u' +
                  ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
          });
      }

  // In the second stage, we run the text against regular expressions that look
  // for non-JSON patterns. We are especially concerned with '()' and 'new'
  // because they can cause invocation, and '=' because it can cause mutation.
  // But just to be safe, we want to reject all unexpected forms.

  // We split the second stage into 4 regexp operations in order to work around
  // crippling inefficiencies in IE's and Safari's regexp engines. First we
  // replace the JSON backslash pairs with '@' (a non-JSON character). Second, we
  // replace all simple value tokens with ']' characters. Third, we delete all
  // open brackets that follow a colon or comma or that begin the text. Finally,
  // we look to see that the remaining characters are only whitespace or ']' or
  // ',' or ':' or '{' or '}'. If that is so, then the text is safe for eval.

      if (/^[\],:{}\s]*$/
              .test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
                  .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                  .replace(/(?:^|:|,)(?:\s*\[)+/g, ''))) {

  // In the third stage we use the eval function to compile the text into a
  // JavaScript structure. The '{' operator is subject to a syntactic ambiguity
  // in JavaScript: it can begin a block or an object literal. We wrap the text
  // in parens to eliminate the ambiguity.

          j = eval('(' + text + ')');

  // In the optional fourth stage, we recursively walk the new structure, passing
  // each name/value pair to a reviver function for possible transformation.

          return typeof reviver === 'function' ?
              walk({'': j}, '') : j;
      }

  // If the text is not JSON parseable, then a SyntaxError is thrown.

      throw new SyntaxError('JSON.parse');
  };

})(
    'undefined' != typeof io ? io : module.exports
  , typeof JSON !== 'undefined' ? JSON : undefined
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Parser namespace.
   *
   * @namespace
   */

  var parser = exports.parser = {};

  /**
   * Packet types.
   */

  var packets = parser.packets = [
      'disconnect'
    , 'connect'
    , 'heartbeat'
    , 'message'
    , 'json'
    , 'event'
    , 'ack'
    , 'error'
    , 'noop'
  ];

  /**
   * Errors reasons.
   */

  var reasons = parser.reasons = [
      'transport not supported'
    , 'client not handshaken'
    , 'unauthorized'
  ];

  /**
   * Errors advice.
   */

  var advice = parser.advice = [
      'reconnect'
  ];

  /**
   * Shortcuts.
   */

  var JSON = io.JSON
    , indexOf = io.util.indexOf;

  /**
   * Encodes a packet.
   *
   * @api private
   */

  parser.encodePacket = function (packet) {
    var type = indexOf(packets, packet.type)
      , id = packet.id || ''
      , endpoint = packet.endpoint || ''
      , ack = packet.ack
      , data = null;

    switch (packet.type) {
      case 'error':
        var reason = packet.reason ? indexOf(reasons, packet.reason) : ''
          , adv = packet.advice ? indexOf(advice, packet.advice) : '';

        if (reason !== '' || adv !== '')
          data = reason + (adv !== '' ? ('+' + adv) : '');

        break;

      case 'message':
        if (packet.data !== '')
          data = packet.data;
        break;

      case 'event':
        var ev = { name: packet.name };

        if (packet.args && packet.args.length) {
          ev.args = packet.args;
        }

        data = JSON.stringify(ev);
        break;

      case 'json':
        data = JSON.stringify(packet.data);
        break;

      case 'connect':
        if (packet.qs)
          data = packet.qs;
        break;

      case 'ack':
        data = packet.ackId
          + (packet.args && packet.args.length
              ? '+' + JSON.stringify(packet.args) : '');
        break;
    }

    // construct packet with required fragments
    var encoded = [
        type
      , id + (ack == 'data' ? '+' : '')
      , endpoint
    ];

    // data fragment is optional
    if (data !== null && data !== undefined)
      encoded.push(data);

    return encoded.join(':');
  };

  /**
   * Encodes multiple messages (payload).
   *
   * @param {Array} messages
   * @api private
   */

  parser.encodePayload = function (packets) {
    var decoded = '';

    if (packets.length == 1)
      return packets[0];

    for (var i = 0, l = packets.length; i < l; i++) {
      var packet = packets[i];
      decoded += '\ufffd' + packet.length + '\ufffd' + packets[i];
    }

    return decoded;
  };

  /**
   * Decodes a packet
   *
   * @api private
   */

  var regexp = /([^:]+):([0-9]+)?(\+)?:([^:]+)?:?([\s\S]*)?/;

  parser.decodePacket = function (data) {
    var pieces = data.match(regexp);

    if (!pieces) return {};

    var id = pieces[2] || ''
      , data = pieces[5] || ''
      , packet = {
            type: packets[pieces[1]]
          , endpoint: pieces[4] || ''
        };

    // whether we need to acknowledge the packet
    if (id) {
      packet.id = id;
      if (pieces[3])
        packet.ack = 'data';
      else
        packet.ack = true;
    }

    // handle different packet types
    switch (packet.type) {
      case 'error':
        var pieces = data.split('+');
        packet.reason = reasons[pieces[0]] || '';
        packet.advice = advice[pieces[1]] || '';
        break;

      case 'message':
        packet.data = data || '';
        break;

      case 'event':
        try {
          var opts = JSON.parse(data);
          packet.name = opts.name;
          packet.args = opts.args;
        } catch (e) { }

        packet.args = packet.args || [];
        break;

      case 'json':
        try {
          packet.data = JSON.parse(data);
        } catch (e) { }
        break;

      case 'connect':
        packet.qs = data || '';
        break;

      case 'ack':
        var pieces = data.match(/^([0-9]+)(\+)?(.*)/);
        if (pieces) {
          packet.ackId = pieces[1];
          packet.args = [];

          if (pieces[3]) {
            try {
              packet.args = pieces[3] ? JSON.parse(pieces[3]) : [];
            } catch (e) { }
          }
        }
        break;

      case 'disconnect':
      case 'heartbeat':
        break;
    };

    return packet;
  };

  /**
   * Decodes data payload. Detects multiple messages
   *
   * @return {Array} messages
   * @api public
   */

  parser.decodePayload = function (data) {
    // IE doesn't like data[i] for unicode chars, charAt works fine
    if (data.charAt(0) == '\ufffd') {
      var ret = [];

      for (var i = 1, length = ''; i < data.length; i++) {
        if (data.charAt(i) == '\ufffd') {
          ret.push(parser.decodePacket(data.substr(i + 1).substr(0, length)));
          i += Number(length) + 1;
          length = '';
        } else {
          length += data.charAt(i);
        }
      }

      return ret;
    } else {
      return [parser.decodePacket(data)];
    }
  };

})(
    'undefined' != typeof io ? io : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Expose constructor.
   */

  exports.Transport = Transport;

  /**
   * This is the transport template for all supported transport methods.
   *
   * @constructor
   * @api public
   */

  function Transport (socket, sessid) {
    this.socket = socket;
    this.sessid = sessid;
  };

  /**
   * Apply EventEmitter mixin.
   */

  io.util.mixin(Transport, io.EventEmitter);


  /**
   * Indicates whether heartbeats is enabled for this transport
   *
   * @api private
   */

  Transport.prototype.heartbeats = function () {
    return true;
  };

  /**
   * Handles the response from the server. When a new response is received
   * it will automatically update the timeout, decode the message and
   * forwards the response to the onMessage function for further processing.
   *
   * @param {String} data Response from the server.
   * @api private
   */

  Transport.prototype.onData = function (data) {
    this.clearCloseTimeout();

    // If the connection in currently open (or in a reopening state) reset the close
    // timeout since we have just received data. This check is necessary so
    // that we don't reset the timeout on an explicitly disconnected connection.
    if (this.socket.connected || this.socket.connecting || this.socket.reconnecting) {
      this.setCloseTimeout();
    }

    if (data !== '') {
      // todo: we should only do decodePayload for xhr transports
      var msgs = io.parser.decodePayload(data);

      if (msgs && msgs.length) {
        for (var i = 0, l = msgs.length; i < l; i++) {
          this.onPacket(msgs[i]);
        }
      }
    }

    return this;
  };

  /**
   * Handles packets.
   *
   * @api private
   */

  Transport.prototype.onPacket = function (packet) {
    this.socket.setHeartbeatTimeout();

    if (packet.type == 'heartbeat') {
      return this.onHeartbeat();
    }

    if (packet.type == 'connect' && packet.endpoint == '') {
      this.onConnect();
    }

    if (packet.type == 'error' && packet.advice == 'reconnect') {
      this.isOpen = false;
    }

    this.socket.onPacket(packet);

    return this;
  };

  /**
   * Sets close timeout
   *
   * @api private
   */

  Transport.prototype.setCloseTimeout = function () {
    if (!this.closeTimeout) {
      var self = this;

      this.closeTimeout = setTimeout(function () {
        self.onDisconnect();
      }, this.socket.closeTimeout);
    }
  };

  /**
   * Called when transport disconnects.
   *
   * @api private
   */

  Transport.prototype.onDisconnect = function () {
    if (this.isOpen) this.close();
    this.clearTimeouts();
    this.socket.onDisconnect();
    return this;
  };

  /**
   * Called when transport connects
   *
   * @api private
   */

  Transport.prototype.onConnect = function () {
    this.socket.onConnect();
    return this;
  };

  /**
   * Clears close timeout
   *
   * @api private
   */

  Transport.prototype.clearCloseTimeout = function () {
    if (this.closeTimeout) {
      clearTimeout(this.closeTimeout);
      this.closeTimeout = null;
    }
  };

  /**
   * Clear timeouts
   *
   * @api private
   */

  Transport.prototype.clearTimeouts = function () {
    this.clearCloseTimeout();

    if (this.reopenTimeout) {
      clearTimeout(this.reopenTimeout);
    }
  };

  /**
   * Sends a packet
   *
   * @param {Object} packet object.
   * @api private
   */

  Transport.prototype.packet = function (packet) {
    this.send(io.parser.encodePacket(packet));
  };

  /**
   * Send the received heartbeat message back to server. So the server
   * knows we are still connected.
   *
   * @param {String} heartbeat Heartbeat response from the server.
   * @api private
   */

  Transport.prototype.onHeartbeat = function (heartbeat) {
    this.packet({ type: 'heartbeat' });
  };

  /**
   * Called when the transport opens.
   *
   * @api private
   */

  Transport.prototype.onOpen = function () {
    this.isOpen = true;
    this.clearCloseTimeout();
    this.socket.onOpen();
  };

  /**
   * Notifies the base when the connection with the Socket.IO server
   * has been disconnected.
   *
   * @api private
   */

  Transport.prototype.onClose = function () {
    var self = this;

    /* FIXME: reopen delay causing a infinit loop
    this.reopenTimeout = setTimeout(function () {
      self.open();
    }, this.socket.options['reopen delay']);*/

    this.isOpen = false;
    this.socket.onClose();
    this.onDisconnect();
  };

  /**
   * Generates a connection url based on the Socket.IO URL Protocol.
   * See <https://github.com/learnboost/socket.io-node/> for more details.
   *
   * @returns {String} Connection url
   * @api private
   */

  Transport.prototype.prepareUrl = function () {
    var options = this.socket.options;

    return this.scheme() + '://'
      + options.host + ':' + options.port + '/'
      + options.resource + '/' + io.protocol
      + '/' + this.name + '/' + this.sessid;
  };

  /**
   * Checks if the transport is ready to start a connection.
   *
   * @param {Socket} socket The socket instance that needs a transport
   * @param {Function} fn The callback
   * @api private
   */

  Transport.prototype.ready = function (socket, fn) {
    fn.call(this);
  };
})(
    'undefined' != typeof io ? io : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io, global) {

  /**
   * Expose constructor.
   */

  exports.Socket = Socket;

  /**
   * Create a new `Socket.IO client` which can establish a persistent
   * connection with a Socket.IO enabled server.
   *
   * @api public
   */

  function Socket (options) {
    this.options = {
        port: 80
      , secure: false
      , document: 'document' in global ? document : false
      , resource: 'socket.io'
      , transports: io.transports
      , 'connect timeout': 10000
      , 'try multiple transports': true
      , 'reconnect': true
      , 'reconnection delay': 500
      , 'reconnection limit': Infinity
      , 'reopen delay': 3000
      , 'max reconnection attempts': 10
      , 'sync disconnect on unload': false
      , 'auto connect': true
      , 'flash policy port': 10843
      , 'manualFlush': false
    };

    io.util.merge(this.options, options);

    this.connected = false;
    this.open = false;
    this.connecting = false;
    this.reconnecting = false;
    this.namespaces = {};
    this.buffer = [];
    this.doBuffer = false;

    if (this.options['sync disconnect on unload'] &&
        (!this.isXDomain() || io.util.ua.hasCORS)) {
      var self = this;
      io.util.on(global, 'beforeunload', function () {
        self.disconnectSync();
      }, false);
    }

    if (this.options['auto connect']) {
      this.connect();
    }
};

  /**
   * Apply EventEmitter mixin.
   */

  io.util.mixin(Socket, io.EventEmitter);

  /**
   * Returns a namespace listener/emitter for this socket
   *
   * @api public
   */

  Socket.prototype.of = function (name) {
    if (!this.namespaces[name]) {
      this.namespaces[name] = new io.SocketNamespace(this, name);

      if (name !== '') {
        this.namespaces[name].packet({ type: 'connect' });
      }
    }

    return this.namespaces[name];
  };

  /**
   * Emits the given event to the Socket and all namespaces
   *
   * @api private
   */

  Socket.prototype.publish = function () {
    this.emit.apply(this, arguments);

    var nsp;

    for (var i in this.namespaces) {
      if (this.namespaces.hasOwnProperty(i)) {
        nsp = this.of(i);
        nsp.$emit.apply(nsp, arguments);
      }
    }
  };

  /**
   * Performs the handshake
   *
   * @api private
   */

  function empty () { };

  Socket.prototype.handshake = function (fn) {
    var self = this
      , options = this.options;

    function complete (data) {
      if (data instanceof Error) {
        self.connecting = false;
        self.onError(data.message);
      } else {
        fn.apply(null, data.split(':'));
      }
    };

    var url = [
          'http' + (options.secure ? 's' : '') + ':/'
        , options.host + ':' + options.port
        , options.resource
        , io.protocol
        , io.util.query(this.options.query, 't=' + +new Date)
      ].join('/');

    if (this.isXDomain() && !io.util.ua.hasCORS) {
      var insertAt = document.getElementsByTagName('script')[0]
        , script = document.createElement('script');

      script.src = url + '&jsonp=' + io.j.length;
      insertAt.parentNode.insertBefore(script, insertAt);

      io.j.push(function (data) {
        complete(data);
        script.parentNode.removeChild(script);
      });
    } else {
      var xhr = io.util.request();

      xhr.open('GET', url, true);
      if (this.isXDomain()) {
        xhr.withCredentials = true;
      }
      xhr.onreadystatechange = function () {
        if (xhr.readyState == 4) {
          xhr.onreadystatechange = empty;

          if (xhr.status == 200) {
            complete(xhr.responseText);
          } else if (xhr.status == 403) {
            self.onError(xhr.responseText);
          } else {
            self.connecting = false;            
            !self.reconnecting && self.onError(xhr.responseText);
          }
        }
      };
      xhr.send(null);
    }
  };

  /**
   * Find an available transport based on the options supplied in the constructor.
   *
   * @api private
   */

  Socket.prototype.getTransport = function (override) {
    var transports = override || this.transports, match;

    for (var i = 0, transport; transport = transports[i]; i++) {
      if (io.Transport[transport]
        && io.Transport[transport].check(this)
        && (!this.isXDomain() || io.Transport[transport].xdomainCheck(this))) {
        return new io.Transport[transport](this, this.sessionid);
      }
    }

    return null;
  };

  /**
   * Connects to the server.
   *
   * @param {Function} [fn] Callback.
   * @returns {io.Socket}
   * @api public
   */

  Socket.prototype.connect = function (fn) {
    if (this.connecting) {
      return this;
    }

    var self = this;
    self.connecting = true;
    
    this.handshake(function (sid, heartbeat, close, transports) {
      self.sessionid = sid;
      self.closeTimeout = close * 1000;
      self.heartbeatTimeout = heartbeat * 1000;
      if(!self.transports)
          self.transports = self.origTransports = (transports ? io.util.intersect(
              transports.split(',')
            , self.options.transports
          ) : self.options.transports);

      self.setHeartbeatTimeout();

      function connect (transports){
        if (self.transport) self.transport.clearTimeouts();

        self.transport = self.getTransport(transports);
        if (!self.transport) return self.publish('connect_failed');

        // once the transport is ready
        self.transport.ready(self, function () {
          self.connecting = true;
          self.publish('connecting', self.transport.name);
          self.transport.open();

          if (self.options['connect timeout']) {
            self.connectTimeoutTimer = setTimeout(function () {
              if (!self.connected) {
                self.connecting = false;

                if (self.options['try multiple transports']) {
                  var remaining = self.transports;

                  while (remaining.length > 0 && remaining.splice(0,1)[0] !=
                         self.transport.name) {}

                    if (remaining.length){
                      connect(remaining);
                    } else {
                      self.publish('connect_failed');
                    }
                }
              }
            }, self.options['connect timeout']);
          }
        });
      }

      connect(self.transports);

      self.once('connect', function (){
        clearTimeout(self.connectTimeoutTimer);

        fn && typeof fn == 'function' && fn();
      });
    });

    return this;
  };

  /**
   * Clears and sets a new heartbeat timeout using the value given by the
   * server during the handshake.
   *
   * @api private
   */

  Socket.prototype.setHeartbeatTimeout = function () {
    clearTimeout(this.heartbeatTimeoutTimer);
    if(this.transport && !this.transport.heartbeats()) return;

    var self = this;
    this.heartbeatTimeoutTimer = setTimeout(function () {
      self.transport.onClose();
    }, this.heartbeatTimeout);
  };

  /**
   * Sends a message.
   *
   * @param {Object} data packet.
   * @returns {io.Socket}
   * @api public
   */

  Socket.prototype.packet = function (data) {
    if (this.connected && !this.doBuffer) {
      this.transport.packet(data);
    } else {
      this.buffer.push(data);
    }

    return this;
  };

  /**
   * Sets buffer state
   *
   * @api private
   */

  Socket.prototype.setBuffer = function (v) {
    this.doBuffer = v;

    if (!v && this.connected && this.buffer.length) {
      if (!this.options['manualFlush']) {
        this.flushBuffer();
      }
    }
  };

  /**
   * Flushes the buffer data over the wire.
   * To be invoked manually when 'manualFlush' is set to true.
   *
   * @api public
   */

  Socket.prototype.flushBuffer = function() {
    this.transport.payload(this.buffer);
    this.buffer = [];
  };
  

  /**
   * Disconnect the established connect.
   *
   * @returns {io.Socket}
   * @api public
   */

  Socket.prototype.disconnect = function () {
    if (this.connected || this.connecting) {
      if (this.open) {
        this.of('').packet({ type: 'disconnect' });
      }

      // handle disconnection immediately
      this.onDisconnect('booted');
    }

    return this;
  };

  /**
   * Disconnects the socket with a sync XHR.
   *
   * @api private
   */

  Socket.prototype.disconnectSync = function () {
    // ensure disconnection
    var xhr = io.util.request();
    var uri = [
        'http' + (this.options.secure ? 's' : '') + ':/'
      , this.options.host + ':' + this.options.port
      , this.options.resource
      , io.protocol
      , ''
      , this.sessionid
    ].join('/') + '/?disconnect=1';

    xhr.open('GET', uri, false);
    xhr.send(null);

    // handle disconnection immediately
    this.onDisconnect('booted');
  };

  /**
   * Check if we need to use cross domain enabled transports. Cross domain would
   * be a different port or different domain name.
   *
   * @returns {Boolean}
   * @api private
   */

  Socket.prototype.isXDomain = function () {

    var port = global.location.port ||
      ('https:' == global.location.protocol ? 443 : 80);

    return this.options.host !== global.location.hostname 
      || this.options.port != port;
  };

  /**
   * Called upon handshake.
   *
   * @api private
   */

  Socket.prototype.onConnect = function () {
    if (!this.connected) {
      this.connected = true;
      this.connecting = false;
      if (!this.doBuffer) {
        // make sure to flush the buffer
        this.setBuffer(false);
      }
      this.emit('connect');
    }
  };

  /**
   * Called when the transport opens
   *
   * @api private
   */

  Socket.prototype.onOpen = function () {
    this.open = true;
  };

  /**
   * Called when the transport closes.
   *
   * @api private
   */

  Socket.prototype.onClose = function () {
    this.open = false;
    clearTimeout(this.heartbeatTimeoutTimer);
  };

  /**
   * Called when the transport first opens a connection
   *
   * @param text
   */

  Socket.prototype.onPacket = function (packet) {
    this.of(packet.endpoint).onPacket(packet);
  };

  /**
   * Handles an error.
   *
   * @api private
   */

  Socket.prototype.onError = function (err) {
    if (err && err.advice) {
      if (err.advice === 'reconnect' && (this.connected || this.connecting)) {
        this.disconnect();
        if (this.options.reconnect) {
          this.reconnect();
        }
      }
    }

    this.publish('error', err && err.reason ? err.reason : err);
  };

  /**
   * Called when the transport disconnects.
   *
   * @api private
   */

  Socket.prototype.onDisconnect = function (reason) {
    var wasConnected = this.connected
      , wasConnecting = this.connecting;

    this.connected = false;
    this.connecting = false;
    this.open = false;

    if (wasConnected || wasConnecting) {
      this.transport.close();
      this.transport.clearTimeouts();
      if (wasConnected) {
        this.publish('disconnect', reason);

        if ('booted' != reason && this.options.reconnect && !this.reconnecting) {
          this.reconnect();
        }
      }
    }
  };

  /**
   * Called upon reconnection.
   *
   * @api private
   */

  Socket.prototype.reconnect = function () {
    this.reconnecting = true;
    this.reconnectionAttempts = 0;
    this.reconnectionDelay = this.options['reconnection delay'];

    var self = this
      , maxAttempts = this.options['max reconnection attempts']
      , tryMultiple = this.options['try multiple transports']
      , limit = this.options['reconnection limit'];

    function reset () {
      if (self.connected) {
        for (var i in self.namespaces) {
          if (self.namespaces.hasOwnProperty(i) && '' !== i) {
              self.namespaces[i].packet({ type: 'connect' });
          }
        }
        self.publish('reconnect', self.transport.name, self.reconnectionAttempts);
      }

      clearTimeout(self.reconnectionTimer);

      self.removeListener('connect_failed', maybeReconnect);
      self.removeListener('connect', maybeReconnect);

      self.reconnecting = false;

      delete self.reconnectionAttempts;
      delete self.reconnectionDelay;
      delete self.reconnectionTimer;
      delete self.redoTransports;

      self.options['try multiple transports'] = tryMultiple;
    };

    function maybeReconnect () {
      if (!self.reconnecting) {
        return;
      }

      if (self.connected) {
        return reset();
      };

      if (self.connecting && self.reconnecting) {
        return self.reconnectionTimer = setTimeout(maybeReconnect, 1000);
      }

      if (self.reconnectionAttempts++ >= maxAttempts) {
        if (!self.redoTransports) {
          self.on('connect_failed', maybeReconnect);
          self.options['try multiple transports'] = true;
          self.transports = self.origTransports;
          self.transport = self.getTransport();
          self.redoTransports = true;
          self.connect();
        } else {
          self.publish('reconnect_failed');
          reset();
        }
      } else {
        if (self.reconnectionDelay < limit) {
          self.reconnectionDelay *= 2; // exponential back off
        }

        self.connect();
        self.publish('reconnecting', self.reconnectionDelay, self.reconnectionAttempts);
        self.reconnectionTimer = setTimeout(maybeReconnect, self.reconnectionDelay);
      }
    };

    this.options['try multiple transports'] = false;
    this.reconnectionTimer = setTimeout(maybeReconnect, this.reconnectionDelay);

    this.on('connect', maybeReconnect);
  };

})(
    'undefined' != typeof io ? io : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
  , this
);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Expose constructor.
   */

  exports.SocketNamespace = SocketNamespace;

  /**
   * Socket namespace constructor.
   *
   * @constructor
   * @api public
   */

  function SocketNamespace (socket, name) {
    this.socket = socket;
    this.name = name || '';
    this.flags = {};
    this.json = new Flag(this, 'json');
    this.ackPackets = 0;
    this.acks = {};
  };

  /**
   * Apply EventEmitter mixin.
   */

  io.util.mixin(SocketNamespace, io.EventEmitter);

  /**
   * Copies emit since we override it
   *
   * @api private
   */

  SocketNamespace.prototype.$emit = io.EventEmitter.prototype.emit;

  /**
   * Creates a new namespace, by proxying the request to the socket. This
   * allows us to use the synax as we do on the server.
   *
   * @api public
   */

  SocketNamespace.prototype.of = function () {
    return this.socket.of.apply(this.socket, arguments);
  };

  /**
   * Sends a packet.
   *
   * @api private
   */

  SocketNamespace.prototype.packet = function (packet) {
    packet.endpoint = this.name;
    this.socket.packet(packet);
    this.flags = {};
    return this;
  };

  /**
   * Sends a message
   *
   * @api public
   */

  SocketNamespace.prototype.send = function (data, fn) {
    var packet = {
        type: this.flags.json ? 'json' : 'message'
      , data: data
    };

    if ('function' == typeof fn) {
      packet.id = ++this.ackPackets;
      packet.ack = true;
      this.acks[packet.id] = fn;
    }

    return this.packet(packet);
  };

  /**
   * Emits an event
   *
   * @api public
   */
  
  SocketNamespace.prototype.emit = function (name) {
    var args = Array.prototype.slice.call(arguments, 1)
      , lastArg = args[args.length - 1]
      , packet = {
            type: 'event'
          , name: name
        };

    if ('function' == typeof lastArg) {
      packet.id = ++this.ackPackets;
      packet.ack = 'data';
      this.acks[packet.id] = lastArg;
      args = args.slice(0, args.length - 1);
    }

    packet.args = args;

    return this.packet(packet);
  };

  /**
   * Disconnects the namespace
   *
   * @api private
   */

  SocketNamespace.prototype.disconnect = function () {
    if (this.name === '') {
      this.socket.disconnect();
    } else {
      this.packet({ type: 'disconnect' });
      this.$emit('disconnect');
    }

    return this;
  };

  /**
   * Handles a packet
   *
   * @api private
   */

  SocketNamespace.prototype.onPacket = function (packet) {
    var self = this;

    function ack () {
      self.packet({
          type: 'ack'
        , args: io.util.toArray(arguments)
        , ackId: packet.id
      });
    };

    switch (packet.type) {
      case 'connect':
        this.$emit('connect');
        break;

      case 'disconnect':
        if (this.name === '') {
          this.socket.onDisconnect(packet.reason || 'booted');
        } else {
          this.$emit('disconnect', packet.reason);
        }
        break;

      case 'message':
      case 'json':
        var params = ['message', packet.data];

        if (packet.ack == 'data') {
          params.push(ack);
        } else if (packet.ack) {
          this.packet({ type: 'ack', ackId: packet.id });
        }

        this.$emit.apply(this, params);
        break;

      case 'event':
        var params = [packet.name].concat(packet.args);

        if (packet.ack == 'data')
          params.push(ack);

        this.$emit.apply(this, params);
        break;

      case 'ack':
        if (this.acks[packet.ackId]) {
          this.acks[packet.ackId].apply(this, packet.args);
          delete this.acks[packet.ackId];
        }
        break;

      case 'error':
        if (packet.advice){
          this.socket.onError(packet);
        } else {
          if (packet.reason == 'unauthorized') {
            this.$emit('connect_failed', packet.reason);
          } else {
            this.$emit('error', packet.reason);
          }
        }
        break;
    }
  };

  /**
   * Flag interface.
   *
   * @api private
   */

  function Flag (nsp, name) {
    this.namespace = nsp;
    this.name = name;
  };

  /**
   * Send a message
   *
   * @api public
   */

  Flag.prototype.send = function () {
    this.namespace.flags[this.name] = true;
    this.namespace.send.apply(this.namespace, arguments);
  };

  /**
   * Emit an event
   *
   * @api public
   */

  Flag.prototype.emit = function () {
    this.namespace.flags[this.name] = true;
    this.namespace.emit.apply(this.namespace, arguments);
  };

})(
    'undefined' != typeof io ? io : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io, global) {

  /**
   * Expose constructor.
   */

  exports.websocket = WS;

  /**
   * The WebSocket transport uses the HTML5 WebSocket API to establish an
   * persistent connection with the Socket.IO server. This transport will also
   * be inherited by the FlashSocket fallback as it provides a API compatible
   * polyfill for the WebSockets.
   *
   * @constructor
   * @extends {io.Transport}
   * @api public
   */

  function WS (socket) {
    io.Transport.apply(this, arguments);
  };

  /**
   * Inherits from Transport.
   */

  io.util.inherit(WS, io.Transport);

  /**
   * Transport name
   *
   * @api public
   */

  WS.prototype.name = 'websocket';

  /**
   * Initializes a new `WebSocket` connection with the Socket.IO server. We attach
   * all the appropriate listeners to handle the responses from the server.
   *
   * @returns {Transport}
   * @api public
   */

  WS.prototype.open = function () {
    var query = io.util.query(this.socket.options.query)
      , self = this
      , Socket


    if (!Socket) {
      Socket = global.MozWebSocket || global.WebSocket;
    }

    this.websocket = new Socket(this.prepareUrl() + query);

    this.websocket.onopen = function () {
      self.onOpen();
      self.socket.setBuffer(false);
    };
    this.websocket.onmessage = function (ev) {
      self.onData(ev.data);
    };
    this.websocket.onclose = function () {
      self.onClose();
      self.socket.setBuffer(true);
    };
    this.websocket.onerror = function (e) {
      self.onError(e);
    };

    return this;
  };

  /**
   * Send a message to the Socket.IO server. The message will automatically be
   * encoded in the correct message format.
   *
   * @returns {Transport}
   * @api public
   */

  // Do to a bug in the current IDevices browser, we need to wrap the send in a 
  // setTimeout, when they resume from sleeping the browser will crash if 
  // we don't allow the browser time to detect the socket has been closed
  if (io.util.ua.iDevice) {
    WS.prototype.send = function (data) {
      var self = this;
      setTimeout(function() {
         self.websocket.send(data);
      },0);
      return this;
    };
  } else {
    WS.prototype.send = function (data) {
      this.websocket.send(data);
      return this;
    };
  }

  /**
   * Payload
   *
   * @api private
   */

  WS.prototype.payload = function (arr) {
    for (var i = 0, l = arr.length; i < l; i++) {
      this.packet(arr[i]);
    }
    return this;
  };

  /**
   * Disconnect the established `WebSocket` connection.
   *
   * @returns {Transport}
   * @api public
   */

  WS.prototype.close = function () {
    this.websocket.close();
    return this;
  };

  /**
   * Handle the errors that `WebSocket` might be giving when we
   * are attempting to connect or send messages.
   *
   * @param {Error} e The error.
   * @api private
   */

  WS.prototype.onError = function (e) {
    this.socket.onError(e);
  };

  /**
   * Returns the appropriate scheme for the URI generation.
   *
   * @api private
   */
  WS.prototype.scheme = function () {
    return this.socket.options.secure ? 'wss' : 'ws';
  };

  /**
   * Checks if the browser has support for native `WebSockets` and that
   * it's not the polyfill created for the FlashSocket transport.
   *
   * @return {Boolean}
   * @api public
   */

  WS.check = function () {
    return ('WebSocket' in global && !('__addTask' in WebSocket))
          || 'MozWebSocket' in global;
  };

  /**
   * Check if the `WebSocket` transport support cross domain communications.
   *
   * @returns {Boolean}
   * @api public
   */

  WS.xdomainCheck = function () {
    return true;
  };

  /**
   * Add the transport to your public io.transports array.
   *
   * @api private
   */

  io.transports.push('websocket');

})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
  , this
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Expose constructor.
   */

  exports.flashsocket = Flashsocket;

  /**
   * The FlashSocket transport. This is a API wrapper for the HTML5 WebSocket
   * specification. It uses a .swf file to communicate with the server. If you want
   * to serve the .swf file from a other server than where the Socket.IO script is
   * coming from you need to use the insecure version of the .swf. More information
   * about this can be found on the github page.
   *
   * @constructor
   * @extends {io.Transport.websocket}
   * @api public
   */

  function Flashsocket () {
    io.Transport.websocket.apply(this, arguments);
  };

  /**
   * Inherits from Transport.
   */

  io.util.inherit(Flashsocket, io.Transport.websocket);

  /**
   * Transport name
   *
   * @api public
   */

  Flashsocket.prototype.name = 'flashsocket';

  /**
   * Disconnect the established `FlashSocket` connection. This is done by adding a 
   * new task to the FlashSocket. The rest will be handled off by the `WebSocket` 
   * transport.
   *
   * @returns {Transport}
   * @api public
   */

  Flashsocket.prototype.open = function () {
    var self = this
      , args = arguments;

    WebSocket.__addTask(function () {
      io.Transport.websocket.prototype.open.apply(self, args);
    });
    return this;
  };
  
  /**
   * Sends a message to the Socket.IO server. This is done by adding a new
   * task to the FlashSocket. The rest will be handled off by the `WebSocket` 
   * transport.
   *
   * @returns {Transport}
   * @api public
   */

  Flashsocket.prototype.send = function () {
    var self = this, args = arguments;
    WebSocket.__addTask(function () {
      io.Transport.websocket.prototype.send.apply(self, args);
    });
    return this;
  };

  /**
   * Disconnects the established `FlashSocket` connection.
   *
   * @returns {Transport}
   * @api public
   */

  Flashsocket.prototype.close = function () {
    WebSocket.__tasks.length = 0;
    io.Transport.websocket.prototype.close.call(this);
    return this;
  };

  /**
   * The WebSocket fall back needs to append the flash container to the body
   * element, so we need to make sure we have access to it. Or defer the call
   * until we are sure there is a body element.
   *
   * @param {Socket} socket The socket instance that needs a transport
   * @param {Function} fn The callback
   * @api private
   */

  Flashsocket.prototype.ready = function (socket, fn) {
    function init () {
      var options = socket.options
        , port = options['flash policy port']
        , path = [
              'http' + (options.secure ? 's' : '') + ':/'
            , options.host + ':' + options.port
            , options.resource
            , 'static/flashsocket'
            , 'WebSocketMain' + (socket.isXDomain() ? 'Insecure' : '') + '.swf'
          ];

      // Only start downloading the swf file when the checked that this browser
      // actually supports it
      if (!Flashsocket.loaded) {
        if (typeof WEB_SOCKET_SWF_LOCATION === 'undefined') {
          // Set the correct file based on the XDomain settings
          WEB_SOCKET_SWF_LOCATION = path.join('/');
        }

        if (port !== 843) {
          WebSocket.loadFlashPolicyFile('xmlsocket://' + options.host + ':' + port);
        }

        WebSocket.__initialize();
        Flashsocket.loaded = true;
      }

      fn.call(self);
    }

    var self = this;
    if (document.body) return init();

    io.util.load(init);
  };

  /**
   * Check if the FlashSocket transport is supported as it requires that the Adobe
   * Flash Player plug-in version `10.0.0` or greater is installed. And also check if
   * the polyfill is correctly loaded.
   *
   * @returns {Boolean}
   * @api public
   */

  Flashsocket.check = function () {
    if (
        typeof WebSocket == 'undefined'
      || !('__initialize' in WebSocket) || !swfobject
    ) return false;

    return swfobject.getFlashPlayerVersion().major >= 10;
  };

  /**
   * Check if the FlashSocket transport can be used as cross domain / cross origin 
   * transport. Because we can't see which type (secure or insecure) of .swf is used
   * we will just return true.
   *
   * @returns {Boolean}
   * @api public
   */

  Flashsocket.xdomainCheck = function () {
    return true;
  };

  /**
   * Disable AUTO_INITIALIZATION
   */

  if (typeof window != 'undefined') {
    WEB_SOCKET_DISABLE_AUTO_INITIALIZATION = true;
  }

  /**
   * Add the transport to your public io.transports array.
   *
   * @api private
   */

  io.transports.push('flashsocket');
})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);
/*  SWFObject v2.2 <http://code.google.com/p/swfobject/> 
  is released under the MIT License <http://www.opensource.org/licenses/mit-license.php> 
*/
if ('undefined' != typeof window) {
var swfobject=function(){var D="undefined",r="object",S="Shockwave Flash",W="ShockwaveFlash.ShockwaveFlash",q="application/x-shockwave-flash",R="SWFObjectExprInst",x="onreadystatechange",O=window,j=document,t=navigator,T=false,U=[h],o=[],N=[],I=[],l,Q,E,B,J=false,a=false,n,G,m=true,M=function(){var aa=typeof j.getElementById!=D&&typeof j.getElementsByTagName!=D&&typeof j.createElement!=D,ah=t.userAgent.toLowerCase(),Y=t.platform.toLowerCase(),ae=Y?/win/.test(Y):/win/.test(ah),ac=Y?/mac/.test(Y):/mac/.test(ah),af=/webkit/.test(ah)?parseFloat(ah.replace(/^.*webkit\/(\d+(\.\d+)?).*$/,"$1")):false,X=!+"\v1",ag=[0,0,0],ab=null;if(typeof t.plugins!=D&&typeof t.plugins[S]==r){ab=t.plugins[S].description;if(ab&&!(typeof t.mimeTypes!=D&&t.mimeTypes[q]&&!t.mimeTypes[q].enabledPlugin)){T=true;X=false;ab=ab.replace(/^.*\s+(\S+\s+\S+$)/,"$1");ag[0]=parseInt(ab.replace(/^(.*)\..*$/,"$1"),10);ag[1]=parseInt(ab.replace(/^.*\.(.*)\s.*$/,"$1"),10);ag[2]=/[a-zA-Z]/.test(ab)?parseInt(ab.replace(/^.*[a-zA-Z]+(.*)$/,"$1"),10):0}}else{if(typeof O[(['Active'].concat('Object').join('X'))]!=D){try{var ad=new window[(['Active'].concat('Object').join('X'))](W);if(ad){ab=ad.GetVariable("$version");if(ab){X=true;ab=ab.split(" ")[1].split(",");ag=[parseInt(ab[0],10),parseInt(ab[1],10),parseInt(ab[2],10)]}}}catch(Z){}}}return{w3:aa,pv:ag,wk:af,ie:X,win:ae,mac:ac}}(),k=function(){if(!M.w3){return}if((typeof j.readyState!=D&&j.readyState=="complete")||(typeof j.readyState==D&&(j.getElementsByTagName("body")[0]||j.body))){f()}if(!J){if(typeof j.addEventListener!=D){j.addEventListener("DOMContentLoaded",f,false)}if(M.ie&&M.win){j.attachEvent(x,function(){if(j.readyState=="complete"){j.detachEvent(x,arguments.callee);f()}});if(O==top){(function(){if(J){return}try{j.documentElement.doScroll("left")}catch(X){setTimeout(arguments.callee,0);return}f()})()}}if(M.wk){(function(){if(J){return}if(!/loaded|complete/.test(j.readyState)){setTimeout(arguments.callee,0);return}f()})()}s(f)}}();function f(){if(J){return}try{var Z=j.getElementsByTagName("body")[0].appendChild(C("span"));Z.parentNode.removeChild(Z)}catch(aa){return}J=true;var X=U.length;for(var Y=0;Y<X;Y++){U[Y]()}}function K(X){if(J){X()}else{U[U.length]=X}}function s(Y){if(typeof O.addEventListener!=D){O.addEventListener("load",Y,false)}else{if(typeof j.addEventListener!=D){j.addEventListener("load",Y,false)}else{if(typeof O.attachEvent!=D){i(O,"onload",Y)}else{if(typeof O.onload=="function"){var X=O.onload;O.onload=function(){X();Y()}}else{O.onload=Y}}}}}function h(){if(T){V()}else{H()}}function V(){var X=j.getElementsByTagName("body")[0];var aa=C(r);aa.setAttribute("type",q);var Z=X.appendChild(aa);if(Z){var Y=0;(function(){if(typeof Z.GetVariable!=D){var ab=Z.GetVariable("$version");if(ab){ab=ab.split(" ")[1].split(",");M.pv=[parseInt(ab[0],10),parseInt(ab[1],10),parseInt(ab[2],10)]}}else{if(Y<10){Y++;setTimeout(arguments.callee,10);return}}X.removeChild(aa);Z=null;H()})()}else{H()}}function H(){var ag=o.length;if(ag>0){for(var af=0;af<ag;af++){var Y=o[af].id;var ab=o[af].callbackFn;var aa={success:false,id:Y};if(M.pv[0]>0){var ae=c(Y);if(ae){if(F(o[af].swfVersion)&&!(M.wk&&M.wk<312)){w(Y,true);if(ab){aa.success=true;aa.ref=z(Y);ab(aa)}}else{if(o[af].expressInstall&&A()){var ai={};ai.data=o[af].expressInstall;ai.width=ae.getAttribute("width")||"0";ai.height=ae.getAttribute("height")||"0";if(ae.getAttribute("class")){ai.styleclass=ae.getAttribute("class")}if(ae.getAttribute("align")){ai.align=ae.getAttribute("align")}var ah={};var X=ae.getElementsByTagName("param");var ac=X.length;for(var ad=0;ad<ac;ad++){if(X[ad].getAttribute("name").toLowerCase()!="movie"){ah[X[ad].getAttribute("name")]=X[ad].getAttribute("value")}}P(ai,ah,Y,ab)}else{p(ae);if(ab){ab(aa)}}}}}else{w(Y,true);if(ab){var Z=z(Y);if(Z&&typeof Z.SetVariable!=D){aa.success=true;aa.ref=Z}ab(aa)}}}}}function z(aa){var X=null;var Y=c(aa);if(Y&&Y.nodeName=="OBJECT"){if(typeof Y.SetVariable!=D){X=Y}else{var Z=Y.getElementsByTagName(r)[0];if(Z){X=Z}}}return X}function A(){return !a&&F("6.0.65")&&(M.win||M.mac)&&!(M.wk&&M.wk<312)}function P(aa,ab,X,Z){a=true;E=Z||null;B={success:false,id:X};var ae=c(X);if(ae){if(ae.nodeName=="OBJECT"){l=g(ae);Q=null}else{l=ae;Q=X}aa.id=R;if(typeof aa.width==D||(!/%$/.test(aa.width)&&parseInt(aa.width,10)<310)){aa.width="310"}if(typeof aa.height==D||(!/%$/.test(aa.height)&&parseInt(aa.height,10)<137)){aa.height="137"}j.title=j.title.slice(0,47)+" - Flash Player Installation";var ad=M.ie&&M.win?(['Active'].concat('').join('X')):"PlugIn",ac="MMredirectURL="+O.location.toString().replace(/&/g,"%26")+"&MMplayerType="+ad+"&MMdoctitle="+j.title;if(typeof ab.flashvars!=D){ab.flashvars+="&"+ac}else{ab.flashvars=ac}if(M.ie&&M.win&&ae.readyState!=4){var Y=C("div");X+="SWFObjectNew";Y.setAttribute("id",X);ae.parentNode.insertBefore(Y,ae);ae.style.display="none";(function(){if(ae.readyState==4){ae.parentNode.removeChild(ae)}else{setTimeout(arguments.callee,10)}})()}u(aa,ab,X)}}function p(Y){if(M.ie&&M.win&&Y.readyState!=4){var X=C("div");Y.parentNode.insertBefore(X,Y);X.parentNode.replaceChild(g(Y),X);Y.style.display="none";(function(){if(Y.readyState==4){Y.parentNode.removeChild(Y)}else{setTimeout(arguments.callee,10)}})()}else{Y.parentNode.replaceChild(g(Y),Y)}}function g(ab){var aa=C("div");if(M.win&&M.ie){aa.innerHTML=ab.innerHTML}else{var Y=ab.getElementsByTagName(r)[0];if(Y){var ad=Y.childNodes;if(ad){var X=ad.length;for(var Z=0;Z<X;Z++){if(!(ad[Z].nodeType==1&&ad[Z].nodeName=="PARAM")&&!(ad[Z].nodeType==8)){aa.appendChild(ad[Z].cloneNode(true))}}}}}return aa}function u(ai,ag,Y){var X,aa=c(Y);if(M.wk&&M.wk<312){return X}if(aa){if(typeof ai.id==D){ai.id=Y}if(M.ie&&M.win){var ah="";for(var ae in ai){if(ai[ae]!=Object.prototype[ae]){if(ae.toLowerCase()=="data"){ag.movie=ai[ae]}else{if(ae.toLowerCase()=="styleclass"){ah+=' class="'+ai[ae]+'"'}else{if(ae.toLowerCase()!="classid"){ah+=" "+ae+'="'+ai[ae]+'"'}}}}}var af="";for(var ad in ag){if(ag[ad]!=Object.prototype[ad]){af+='<param name="'+ad+'" value="'+ag[ad]+'" />'}}aa.outerHTML='<object classid="clsid:D27CDB6E-AE6D-11cf-96B8-444553540000"'+ah+">"+af+"</object>";N[N.length]=ai.id;X=c(ai.id)}else{var Z=C(r);Z.setAttribute("type",q);for(var ac in ai){if(ai[ac]!=Object.prototype[ac]){if(ac.toLowerCase()=="styleclass"){Z.setAttribute("class",ai[ac])}else{if(ac.toLowerCase()!="classid"){Z.setAttribute(ac,ai[ac])}}}}for(var ab in ag){if(ag[ab]!=Object.prototype[ab]&&ab.toLowerCase()!="movie"){e(Z,ab,ag[ab])}}aa.parentNode.replaceChild(Z,aa);X=Z}}return X}function e(Z,X,Y){var aa=C("param");aa.setAttribute("name",X);aa.setAttribute("value",Y);Z.appendChild(aa)}function y(Y){var X=c(Y);if(X&&X.nodeName=="OBJECT"){if(M.ie&&M.win){X.style.display="none";(function(){if(X.readyState==4){b(Y)}else{setTimeout(arguments.callee,10)}})()}else{X.parentNode.removeChild(X)}}}function b(Z){var Y=c(Z);if(Y){for(var X in Y){if(typeof Y[X]=="function"){Y[X]=null}}Y.parentNode.removeChild(Y)}}function c(Z){var X=null;try{X=j.getElementById(Z)}catch(Y){}return X}function C(X){return j.createElement(X)}function i(Z,X,Y){Z.attachEvent(X,Y);I[I.length]=[Z,X,Y]}function F(Z){var Y=M.pv,X=Z.split(".");X[0]=parseInt(X[0],10);X[1]=parseInt(X[1],10)||0;X[2]=parseInt(X[2],10)||0;return(Y[0]>X[0]||(Y[0]==X[0]&&Y[1]>X[1])||(Y[0]==X[0]&&Y[1]==X[1]&&Y[2]>=X[2]))?true:false}function v(ac,Y,ad,ab){if(M.ie&&M.mac){return}var aa=j.getElementsByTagName("head")[0];if(!aa){return}var X=(ad&&typeof ad=="string")?ad:"screen";if(ab){n=null;G=null}if(!n||G!=X){var Z=C("style");Z.setAttribute("type","text/css");Z.setAttribute("media",X);n=aa.appendChild(Z);if(M.ie&&M.win&&typeof j.styleSheets!=D&&j.styleSheets.length>0){n=j.styleSheets[j.styleSheets.length-1]}G=X}if(M.ie&&M.win){if(n&&typeof n.addRule==r){n.addRule(ac,Y)}}else{if(n&&typeof j.createTextNode!=D){n.appendChild(j.createTextNode(ac+" {"+Y+"}"))}}}function w(Z,X){if(!m){return}var Y=X?"visible":"hidden";if(J&&c(Z)){c(Z).style.visibility=Y}else{v("#"+Z,"visibility:"+Y)}}function L(Y){var Z=/[\\\"<>\.;]/;var X=Z.exec(Y)!=null;return X&&typeof encodeURIComponent!=D?encodeURIComponent(Y):Y}var d=function(){if(M.ie&&M.win){window.attachEvent("onunload",function(){var ac=I.length;for(var ab=0;ab<ac;ab++){I[ab][0].detachEvent(I[ab][1],I[ab][2])}var Z=N.length;for(var aa=0;aa<Z;aa++){y(N[aa])}for(var Y in M){M[Y]=null}M=null;for(var X in swfobject){swfobject[X]=null}swfobject=null})}}();return{registerObject:function(ab,X,aa,Z){if(M.w3&&ab&&X){var Y={};Y.id=ab;Y.swfVersion=X;Y.expressInstall=aa;Y.callbackFn=Z;o[o.length]=Y;w(ab,false)}else{if(Z){Z({success:false,id:ab})}}},getObjectById:function(X){if(M.w3){return z(X)}},embedSWF:function(ab,ah,ae,ag,Y,aa,Z,ad,af,ac){var X={success:false,id:ah};if(M.w3&&!(M.wk&&M.wk<312)&&ab&&ah&&ae&&ag&&Y){w(ah,false);K(function(){ae+="";ag+="";var aj={};if(af&&typeof af===r){for(var al in af){aj[al]=af[al]}}aj.data=ab;aj.width=ae;aj.height=ag;var am={};if(ad&&typeof ad===r){for(var ak in ad){am[ak]=ad[ak]}}if(Z&&typeof Z===r){for(var ai in Z){if(typeof am.flashvars!=D){am.flashvars+="&"+ai+"="+Z[ai]}else{am.flashvars=ai+"="+Z[ai]}}}if(F(Y)){var an=u(aj,am,ah);if(aj.id==ah){w(ah,true)}X.success=true;X.ref=an}else{if(aa&&A()){aj.data=aa;P(aj,am,ah,ac);return}else{w(ah,true)}}if(ac){ac(X)}})}else{if(ac){ac(X)}}},switchOffAutoHideShow:function(){m=false},ua:M,getFlashPlayerVersion:function(){return{major:M.pv[0],minor:M.pv[1],release:M.pv[2]}},hasFlashPlayerVersion:F,createSWF:function(Z,Y,X){if(M.w3){return u(Z,Y,X)}else{return undefined}},showExpressInstall:function(Z,aa,X,Y){if(M.w3&&A()){P(Z,aa,X,Y)}},removeSWF:function(X){if(M.w3){y(X)}},createCSS:function(aa,Z,Y,X){if(M.w3){v(aa,Z,Y,X)}},addDomLoadEvent:K,addLoadEvent:s,getQueryParamValue:function(aa){var Z=j.location.search||j.location.hash;if(Z){if(/\?/.test(Z)){Z=Z.split("?")[1]}if(aa==null){return L(Z)}var Y=Z.split("&");for(var X=0;X<Y.length;X++){if(Y[X].substring(0,Y[X].indexOf("="))==aa){return L(Y[X].substring((Y[X].indexOf("=")+1)))}}}return""},expressInstallCallback:function(){if(a){var X=c(R);if(X&&l){X.parentNode.replaceChild(l,X);if(Q){w(Q,true);if(M.ie&&M.win){l.style.display="block"}}if(E){E(B)}}a=false}}}}();
}
// Copyright: Hiroshi Ichikawa <http://gimite.net/en/>
// License: New BSD License
// Reference: http://dev.w3.org/html5/websockets/
// Reference: http://tools.ietf.org/html/draft-hixie-thewebsocketprotocol

(function() {
  
  if ('undefined' == typeof window || window.WebSocket) return;

  var console = window.console;
  if (!console || !console.log || !console.error) {
    console = {log: function(){ }, error: function(){ }};
  }
  
  if (!swfobject.hasFlashPlayerVersion("10.0.0")) {
    console.error("Flash Player >= 10.0.0 is required.");
    return;
  }
  if (location.protocol == "file:") {
    console.error(
      "WARNING: web-socket-js doesn't work in file:///... URL " +
      "unless you set Flash Security Settings properly. " +
      "Open the page via Web server i.e. http://...");
  }

  /**
   * This class represents a faux web socket.
   * @param {string} url
   * @param {array or string} protocols
   * @param {string} proxyHost
   * @param {int} proxyPort
   * @param {string} headers
   */
  WebSocket = function(url, protocols, proxyHost, proxyPort, headers) {
    var self = this;
    self.__id = WebSocket.__nextId++;
    WebSocket.__instances[self.__id] = self;
    self.readyState = WebSocket.CONNECTING;
    self.bufferedAmount = 0;
    self.__events = {};
    if (!protocols) {
      protocols = [];
    } else if (typeof protocols == "string") {
      protocols = [protocols];
    }
    // Uses setTimeout() to make sure __createFlash() runs after the caller sets ws.onopen etc.
    // Otherwise, when onopen fires immediately, onopen is called before it is set.
    setTimeout(function() {
      WebSocket.__addTask(function() {
        WebSocket.__flash.create(
            self.__id, url, protocols, proxyHost || null, proxyPort || 0, headers || null);
      });
    }, 0);
  };

  /**
   * Send data to the web socket.
   * @param {string} data  The data to send to the socket.
   * @return {boolean}  True for success, false for failure.
   */
  WebSocket.prototype.send = function(data) {
    if (this.readyState == WebSocket.CONNECTING) {
      throw "INVALID_STATE_ERR: Web Socket connection has not been established";
    }
    // We use encodeURIComponent() here, because FABridge doesn't work if
    // the argument includes some characters. We don't use escape() here
    // because of this:
    // https://developer.mozilla.org/en/Core_JavaScript_1.5_Guide/Functions#escape_and_unescape_Functions
    // But it looks decodeURIComponent(encodeURIComponent(s)) doesn't
    // preserve all Unicode characters either e.g. "\uffff" in Firefox.
    // Note by wtritch: Hopefully this will not be necessary using ExternalInterface.  Will require
    // additional testing.
    var result = WebSocket.__flash.send(this.__id, encodeURIComponent(data));
    if (result < 0) { // success
      return true;
    } else {
      this.bufferedAmount += result;
      return false;
    }
  };

  /**
   * Close this web socket gracefully.
   */
  WebSocket.prototype.close = function() {
    if (this.readyState == WebSocket.CLOSED || this.readyState == WebSocket.CLOSING) {
      return;
    }
    this.readyState = WebSocket.CLOSING;
    WebSocket.__flash.close(this.__id);
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {string} type
   * @param {function} listener
   * @param {boolean} useCapture
   * @return void
   */
  WebSocket.prototype.addEventListener = function(type, listener, useCapture) {
    if (!(type in this.__events)) {
      this.__events[type] = [];
    }
    this.__events[type].push(listener);
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {string} type
   * @param {function} listener
   * @param {boolean} useCapture
   * @return void
   */
  WebSocket.prototype.removeEventListener = function(type, listener, useCapture) {
    if (!(type in this.__events)) return;
    var events = this.__events[type];
    for (var i = events.length - 1; i >= 0; --i) {
      if (events[i] === listener) {
        events.splice(i, 1);
        break;
      }
    }
  };

  /**
   * Implementation of {@link <a href="http://www.w3.org/TR/DOM-Level-2-Events/events.html#Events-registration">DOM 2 EventTarget Interface</a>}
   *
   * @param {Event} event
   * @return void
   */
  WebSocket.prototype.dispatchEvent = function(event) {
    var events = this.__events[event.type] || [];
    for (var i = 0; i < events.length; ++i) {
      events[i](event);
    }
    var handler = this["on" + event.type];
    if (handler) handler(event);
  };

  /**
   * Handles an event from Flash.
   * @param {Object} flashEvent
   */
  WebSocket.prototype.__handleEvent = function(flashEvent) {
    if ("readyState" in flashEvent) {
      this.readyState = flashEvent.readyState;
    }
    if ("protocol" in flashEvent) {
      this.protocol = flashEvent.protocol;
    }
    
    var jsEvent;
    if (flashEvent.type == "open" || flashEvent.type == "error") {
      jsEvent = this.__createSimpleEvent(flashEvent.type);
    } else if (flashEvent.type == "close") {
      // TODO implement jsEvent.wasClean
      jsEvent = this.__createSimpleEvent("close");
    } else if (flashEvent.type == "message") {
      var data = decodeURIComponent(flashEvent.message);
      jsEvent = this.__createMessageEvent("message", data);
    } else {
      throw "unknown event type: " + flashEvent.type;
    }
    
    this.dispatchEvent(jsEvent);
  };
  
  WebSocket.prototype.__createSimpleEvent = function(type) {
    if (document.createEvent && window.Event) {
      var event = document.createEvent("Event");
      event.initEvent(type, false, false);
      return event;
    } else {
      return {type: type, bubbles: false, cancelable: false};
    }
  };
  
  WebSocket.prototype.__createMessageEvent = function(type, data) {
    if (document.createEvent && window.MessageEvent && !window.opera) {
      var event = document.createEvent("MessageEvent");
      event.initMessageEvent("message", false, false, data, null, null, window, null);
      return event;
    } else {
      // IE and Opera, the latter one truncates the data parameter after any 0x00 bytes.
      return {type: type, data: data, bubbles: false, cancelable: false};
    }
  };
  
  /**
   * Define the WebSocket readyState enumeration.
   */
  WebSocket.CONNECTING = 0;
  WebSocket.OPEN = 1;
  WebSocket.CLOSING = 2;
  WebSocket.CLOSED = 3;

  WebSocket.__flash = null;
  WebSocket.__instances = {};
  WebSocket.__tasks = [];
  WebSocket.__nextId = 0;
  
  /**
   * Load a new flash security policy file.
   * @param {string} url
   */
  WebSocket.loadFlashPolicyFile = function(url){
    WebSocket.__addTask(function() {
      WebSocket.__flash.loadManualPolicyFile(url);
    });
  };

  /**
   * Loads WebSocketMain.swf and creates WebSocketMain object in Flash.
   */
  WebSocket.__initialize = function() {
    if (WebSocket.__flash) return;
    
    if (WebSocket.__swfLocation) {
      // For backword compatibility.
      window.WEB_SOCKET_SWF_LOCATION = WebSocket.__swfLocation;
    }
    if (!window.WEB_SOCKET_SWF_LOCATION) {
      console.error("[WebSocket] set WEB_SOCKET_SWF_LOCATION to location of WebSocketMain.swf");
      return;
    }
    var container = document.createElement("div");
    container.id = "webSocketContainer";
    // Hides Flash box. We cannot use display: none or visibility: hidden because it prevents
    // Flash from loading at least in IE. So we move it out of the screen at (-100, -100).
    // But this even doesn't work with Flash Lite (e.g. in Droid Incredible). So with Flash
    // Lite, we put it at (0, 0). This shows 1x1 box visible at left-top corner but this is
    // the best we can do as far as we know now.
    container.style.position = "absolute";
    if (WebSocket.__isFlashLite()) {
      container.style.left = "0px";
      container.style.top = "0px";
    } else {
      container.style.left = "-100px";
      container.style.top = "-100px";
    }
    var holder = document.createElement("div");
    holder.id = "webSocketFlash";
    container.appendChild(holder);
    document.body.appendChild(container);
    // See this article for hasPriority:
    // http://help.adobe.com/en_US/as3/mobile/WS4bebcd66a74275c36cfb8137124318eebc6-7ffd.html
    swfobject.embedSWF(
      WEB_SOCKET_SWF_LOCATION,
      "webSocketFlash",
      "1" /* width */,
      "1" /* height */,
      "10.0.0" /* SWF version */,
      null,
      null,
      {hasPriority: true, swliveconnect : true, allowScriptAccess: "always"},
      null,
      function(e) {
        if (!e.success) {
          console.error("[WebSocket] swfobject.embedSWF failed");
        }
      });
  };
  
  /**
   * Called by Flash to notify JS that it's fully loaded and ready
   * for communication.
   */
  WebSocket.__onFlashInitialized = function() {
    // We need to set a timeout here to avoid round-trip calls
    // to flash during the initialization process.
    setTimeout(function() {
      WebSocket.__flash = document.getElementById("webSocketFlash");
      WebSocket.__flash.setCallerUrl(location.href);
      WebSocket.__flash.setDebug(!!window.WEB_SOCKET_DEBUG);
      for (var i = 0; i < WebSocket.__tasks.length; ++i) {
        WebSocket.__tasks[i]();
      }
      WebSocket.__tasks = [];
    }, 0);
  };
  
  /**
   * Called by Flash to notify WebSockets events are fired.
   */
  WebSocket.__onFlashEvent = function() {
    setTimeout(function() {
      try {
        // Gets events using receiveEvents() instead of getting it from event object
        // of Flash event. This is to make sure to keep message order.
        // It seems sometimes Flash events don't arrive in the same order as they are sent.
        var events = WebSocket.__flash.receiveEvents();
        for (var i = 0; i < events.length; ++i) {
          WebSocket.__instances[events[i].webSocketId].__handleEvent(events[i]);
        }
      } catch (e) {
        console.error(e);
      }
    }, 0);
    return true;
  };
  
  // Called by Flash.
  WebSocket.__log = function(message) {
    console.log(decodeURIComponent(message));
  };
  
  // Called by Flash.
  WebSocket.__error = function(message) {
    console.error(decodeURIComponent(message));
  };
  
  WebSocket.__addTask = function(task) {
    if (WebSocket.__flash) {
      task();
    } else {
      WebSocket.__tasks.push(task);
    }
  };
  
  /**
   * Test if the browser is running flash lite.
   * @return {boolean} True if flash lite is running, false otherwise.
   */
  WebSocket.__isFlashLite = function() {
    if (!window.navigator || !window.navigator.mimeTypes) {
      return false;
    }
    var mimeType = window.navigator.mimeTypes["application/x-shockwave-flash"];
    if (!mimeType || !mimeType.enabledPlugin || !mimeType.enabledPlugin.filename) {
      return false;
    }
    return mimeType.enabledPlugin.filename.match(/flashlite/i) ? true : false;
  };
  
  if (!window.WEB_SOCKET_DISABLE_AUTO_INITIALIZATION) {
    if (window.addEventListener) {
      window.addEventListener("load", function(){
        WebSocket.__initialize();
      }, false);
    } else {
      window.attachEvent("onload", function(){
        WebSocket.__initialize();
      });
    }
  }
  
})();

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io, global) {

  /**
   * Expose constructor.
   *
   * @api public
   */

  exports.XHR = XHR;

  /**
   * XHR constructor
   *
   * @costructor
   * @api public
   */

  function XHR (socket) {
    if (!socket) return;

    io.Transport.apply(this, arguments);
    this.sendBuffer = [];
  };

  /**
   * Inherits from Transport.
   */

  io.util.inherit(XHR, io.Transport);

  /**
   * Establish a connection
   *
   * @returns {Transport}
   * @api public
   */

  XHR.prototype.open = function () {
    this.socket.setBuffer(false);
    this.onOpen();
    this.get();

    // we need to make sure the request succeeds since we have no indication
    // whether the request opened or not until it succeeded.
    this.setCloseTimeout();

    return this;
  };

  /**
   * Check if we need to send data to the Socket.IO server, if we have data in our
   * buffer we encode it and forward it to the `post` method.
   *
   * @api private
   */

  XHR.prototype.payload = function (payload) {
    var msgs = [];

    for (var i = 0, l = payload.length; i < l; i++) {
      msgs.push(io.parser.encodePacket(payload[i]));
    }

    this.send(io.parser.encodePayload(msgs));
  };

  /**
   * Send data to the Socket.IO server.
   *
   * @param data The message
   * @returns {Transport}
   * @api public
   */

  XHR.prototype.send = function (data) {
    this.post(data);
    return this;
  };

  /**
   * Posts a encoded message to the Socket.IO server.
   *
   * @param {String} data A encoded message.
   * @api private
   */

  function empty () { };

  XHR.prototype.post = function (data) {
    var self = this;
    this.socket.setBuffer(true);

    function stateChange () {
      if (this.readyState == 4) {
        this.onreadystatechange = empty;
        self.posting = false;

        if (this.status == 200){
          self.socket.setBuffer(false);
        } else {
          self.onClose();
        }
      }
    }

    function onload () {
      this.onload = empty;
      self.socket.setBuffer(false);
    };

    this.sendXHR = this.request('POST');

    if (global.XDomainRequest && this.sendXHR instanceof XDomainRequest) {
      this.sendXHR.onload = this.sendXHR.onerror = onload;
    } else {
      this.sendXHR.onreadystatechange = stateChange;
    }

    this.sendXHR.send(data);
  };

  /**
   * Disconnects the established `XHR` connection.
   *
   * @returns {Transport}
   * @api public
   */

  XHR.prototype.close = function () {
    this.onClose();
    return this;
  };

  /**
   * Generates a configured XHR request
   *
   * @param {String} url The url that needs to be requested.
   * @param {String} method The method the request should use.
   * @returns {XMLHttpRequest}
   * @api private
   */

  XHR.prototype.request = function (method) {
    var req = io.util.request(this.socket.isXDomain())
      , query = io.util.query(this.socket.options.query, 't=' + +new Date);

    req.open(method || 'GET', this.prepareUrl() + query, true);

    if (method == 'POST') {
      try {
        if (req.setRequestHeader) {
          req.setRequestHeader('Content-type', 'text/plain;charset=UTF-8');
        } else {
          // XDomainRequest
          req.contentType = 'text/plain';
        }
      } catch (e) {}
    }

    return req;
  };

  /**
   * Returns the scheme to use for the transport URLs.
   *
   * @api private
   */

  XHR.prototype.scheme = function () {
    return this.socket.options.secure ? 'https' : 'http';
  };

  /**
   * Check if the XHR transports are supported
   *
   * @param {Boolean} xdomain Check if we support cross domain requests.
   * @returns {Boolean}
   * @api public
   */

  XHR.check = function (socket, xdomain) {
    try {
      var request = io.util.request(xdomain),
          usesXDomReq = (global.XDomainRequest && request instanceof XDomainRequest),
          socketProtocol = (socket && socket.options && socket.options.secure ? 'https:' : 'http:'),
          isXProtocol = (global.location && socketProtocol != global.location.protocol);
      if (request && !(usesXDomReq && isXProtocol)) {
        return true;
      }
    } catch(e) {}

    return false;
  };

  /**
   * Check if the XHR transport supports cross domain requests.
   *
   * @returns {Boolean}
   * @api public
   */

  XHR.xdomainCheck = function (socket) {
    return XHR.check(socket, true);
  };

})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
  , this
);
/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io) {

  /**
   * Expose constructor.
   */

  exports.htmlfile = HTMLFile;

  /**
   * The HTMLFile transport creates a `forever iframe` based transport
   * for Internet Explorer. Regular forever iframe implementations will 
   * continuously trigger the browsers buzy indicators. If the forever iframe
   * is created inside a `htmlfile` these indicators will not be trigged.
   *
   * @constructor
   * @extends {io.Transport.XHR}
   * @api public
   */

  function HTMLFile (socket) {
    io.Transport.XHR.apply(this, arguments);
  };

  /**
   * Inherits from XHR transport.
   */

  io.util.inherit(HTMLFile, io.Transport.XHR);

  /**
   * Transport name
   *
   * @api public
   */

  HTMLFile.prototype.name = 'htmlfile';

  /**
   * Creates a new Ac...eX `htmlfile` with a forever loading iframe
   * that can be used to listen to messages. Inside the generated
   * `htmlfile` a reference will be made to the HTMLFile transport.
   *
   * @api private
   */

  HTMLFile.prototype.get = function () {
    this.doc = new window[(['Active'].concat('Object').join('X'))]('htmlfile');
    this.doc.open();
    this.doc.write('<html></html>');
    this.doc.close();
    this.doc.parentWindow.s = this;

    var iframeC = this.doc.createElement('div');
    iframeC.className = 'socketio';

    this.doc.body.appendChild(iframeC);
    this.iframe = this.doc.createElement('iframe');

    iframeC.appendChild(this.iframe);

    var self = this
      , query = io.util.query(this.socket.options.query, 't='+ +new Date);

    this.iframe.src = this.prepareUrl() + query;

    io.util.on(window, 'unload', function () {
      self.destroy();
    });
  };

  /**
   * The Socket.IO server will write script tags inside the forever
   * iframe, this function will be used as callback for the incoming
   * information.
   *
   * @param {String} data The message
   * @param {document} doc Reference to the context
   * @api private
   */

  HTMLFile.prototype._ = function (data, doc) {
    // unescape all forward slashes. see GH-1251
    data = data.replace(/\\\//g, '/');
    this.onData(data);
    try {
      var script = doc.getElementsByTagName('script')[0];
      script.parentNode.removeChild(script);
    } catch (e) { }
  };

  /**
   * Destroy the established connection, iframe and `htmlfile`.
   * And calls the `CollectGarbage` function of Internet Explorer
   * to release the memory.
   *
   * @api private
   */

  HTMLFile.prototype.destroy = function () {
    if (this.iframe){
      try {
        this.iframe.src = 'about:blank';
      } catch(e){}

      this.doc = null;
      this.iframe.parentNode.removeChild(this.iframe);
      this.iframe = null;

      CollectGarbage();
    }
  };

  /**
   * Disconnects the established connection.
   *
   * @returns {Transport} Chaining.
   * @api public
   */

  HTMLFile.prototype.close = function () {
    this.destroy();
    return io.Transport.XHR.prototype.close.call(this);
  };

  /**
   * Checks if the browser supports this transport. The browser
   * must have an `Ac...eXObject` implementation.
   *
   * @return {Boolean}
   * @api public
   */

  HTMLFile.check = function (socket) {
    if (typeof window != "undefined" && (['Active'].concat('Object').join('X')) in window){
      try {
        var a = new window[(['Active'].concat('Object').join('X'))]('htmlfile');
        return a && io.Transport.XHR.check(socket);
      } catch(e){}
    }
    return false;
  };

  /**
   * Check if cross domain requests are supported.
   *
   * @returns {Boolean}
   * @api public
   */

  HTMLFile.xdomainCheck = function () {
    // we can probably do handling for sub-domains, we should
    // test that it's cross domain but a subdomain here
    return false;
  };

  /**
   * Add the transport to your public io.transports array.
   *
   * @api private
   */

  io.transports.push('htmlfile');

})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io, global) {

  /**
   * Expose constructor.
   */

  exports['xhr-polling'] = XHRPolling;

  /**
   * The XHR-polling transport uses long polling XHR requests to create a
   * "persistent" connection with the server.
   *
   * @constructor
   * @api public
   */

  function XHRPolling () {
    io.Transport.XHR.apply(this, arguments);
  };

  /**
   * Inherits from XHR transport.
   */

  io.util.inherit(XHRPolling, io.Transport.XHR);

  /**
   * Merge the properties from XHR transport
   */

  io.util.merge(XHRPolling, io.Transport.XHR);

  /**
   * Transport name
   *
   * @api public
   */

  XHRPolling.prototype.name = 'xhr-polling';

  /**
   * Indicates whether heartbeats is enabled for this transport
   *
   * @api private
   */

  XHRPolling.prototype.heartbeats = function () {
    return false;
  };

  /** 
   * Establish a connection, for iPhone and Android this will be done once the page
   * is loaded.
   *
   * @returns {Transport} Chaining.
   * @api public
   */

  XHRPolling.prototype.open = function () {
    var self = this;

    io.Transport.XHR.prototype.open.call(self);
    return false;
  };

  /**
   * Starts a XHR request to wait for incoming messages.
   *
   * @api private
   */

  function empty () {};

  XHRPolling.prototype.get = function () {
    if (!this.isOpen) return;

    var self = this;

    function stateChange () {
      if (this.readyState == 4) {
        this.onreadystatechange = empty;

        if (this.status == 200) {
          self.onData(this.responseText);
          self.get();
        } else {
          self.onClose();
        }
      }
    };

    function onload () {
      this.onload = empty;
      this.onerror = empty;
      self.retryCounter = 1;
      self.onData(this.responseText);
      self.get();
    };

    function onerror () {
      self.retryCounter ++;
      if(!self.retryCounter || self.retryCounter > 3) {
        self.onClose();  
      } else {
        self.get();
      }
    };

    this.xhr = this.request();

    if (global.XDomainRequest && this.xhr instanceof XDomainRequest) {
      this.xhr.onload = onload;
      this.xhr.onerror = onerror;
    } else {
      this.xhr.onreadystatechange = stateChange;
    }

    this.xhr.send(null);
  };

  /**
   * Handle the unclean close behavior.
   *
   * @api private
   */

  XHRPolling.prototype.onClose = function () {
    io.Transport.XHR.prototype.onClose.call(this);

    if (this.xhr) {
      this.xhr.onreadystatechange = this.xhr.onload = this.xhr.onerror = empty;
      try {
        this.xhr.abort();
      } catch(e){}
      this.xhr = null;
    }
  };

  /**
   * Webkit based browsers show a infinit spinner when you start a XHR request
   * before the browsers onload event is called so we need to defer opening of
   * the transport until the onload event is called. Wrapping the cb in our
   * defer method solve this.
   *
   * @param {Socket} socket The socket instance that needs a transport
   * @param {Function} fn The callback
   * @api private
   */

  XHRPolling.prototype.ready = function (socket, fn) {
    var self = this;

    io.util.defer(function () {
      fn.call(self);
    });
  };

  /**
   * Add the transport to your public io.transports array.
   *
   * @api private
   */

  io.transports.push('xhr-polling');

})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
  , this
);

/**
 * socket.io
 * Copyright(c) 2011 LearnBoost <dev@learnboost.com>
 * MIT Licensed
 */

(function (exports, io, global) {
  /**
   * There is a way to hide the loading indicator in Firefox. If you create and
   * remove a iframe it will stop showing the current loading indicator.
   * Unfortunately we can't feature detect that and UA sniffing is evil.
   *
   * @api private
   */

  var indicator = global.document && "MozAppearance" in
    global.document.documentElement.style;

  /**
   * Expose constructor.
   */

  exports['jsonp-polling'] = JSONPPolling;

  /**
   * The JSONP transport creates an persistent connection by dynamically
   * inserting a script tag in the page. This script tag will receive the
   * information of the Socket.IO server. When new information is received
   * it creates a new script tag for the new data stream.
   *
   * @constructor
   * @extends {io.Transport.xhr-polling}
   * @api public
   */

  function JSONPPolling (socket) {
    io.Transport['xhr-polling'].apply(this, arguments);

    this.index = io.j.length;

    var self = this;

    io.j.push(function (msg) {
      self._(msg);
    });
  };

  /**
   * Inherits from XHR polling transport.
   */

  io.util.inherit(JSONPPolling, io.Transport['xhr-polling']);

  /**
   * Transport name
   *
   * @api public
   */

  JSONPPolling.prototype.name = 'jsonp-polling';

  /**
   * Posts a encoded message to the Socket.IO server using an iframe.
   * The iframe is used because script tags can create POST based requests.
   * The iframe is positioned outside of the view so the user does not
   * notice it's existence.
   *
   * @param {String} data A encoded message.
   * @api private
   */

  JSONPPolling.prototype.post = function (data) {
    var self = this
      , query = io.util.query(
             this.socket.options.query
          , 't='+ (+new Date) + '&i=' + this.index
        );

    if (!this.form) {
      var form = document.createElement('form')
        , area = document.createElement('textarea')
        , id = this.iframeId = 'socketio_iframe_' + this.index
        , iframe;

      form.className = 'socketio';
      form.style.position = 'absolute';
      form.style.top = '0px';
      form.style.left = '0px';
      form.style.display = 'none';
      form.target = id;
      form.method = 'POST';
      form.setAttribute('accept-charset', 'utf-8');
      area.name = 'd';
      form.appendChild(area);
      document.body.appendChild(form);

      this.form = form;
      this.area = area;
    }

    this.form.action = this.prepareUrl() + query;

    function complete () {
      initIframe();
      self.socket.setBuffer(false);
    };

    function initIframe () {
      if (self.iframe) {
        self.form.removeChild(self.iframe);
      }

      try {
        // ie6 dynamic iframes with target="" support (thanks Chris Lambacher)
        iframe = document.createElement('<iframe name="'+ self.iframeId +'">');
      } catch (e) {
        iframe = document.createElement('iframe');
        iframe.name = self.iframeId;
      }

      iframe.id = self.iframeId;

      self.form.appendChild(iframe);
      self.iframe = iframe;
    };

    initIframe();

    // we temporarily stringify until we figure out how to prevent
    // browsers from turning `\n` into `\r\n` in form inputs
    this.area.value = io.JSON.stringify(data);

    try {
      this.form.submit();
    } catch(e) {}

    if (this.iframe.attachEvent) {
      iframe.onreadystatechange = function () {
        if (self.iframe.readyState == 'complete') {
          complete();
        }
      };
    } else {
      this.iframe.onload = complete;
    }

    this.socket.setBuffer(true);
  };

  /**
   * Creates a new JSONP poll that can be used to listen
   * for messages from the Socket.IO server.
   *
   * @api private
   */

  JSONPPolling.prototype.get = function () {
    var self = this
      , script = document.createElement('script')
      , query = io.util.query(
             this.socket.options.query
          , 't='+ (+new Date) + '&i=' + this.index
        );

    if (this.script) {
      this.script.parentNode.removeChild(this.script);
      this.script = null;
    }

    script.async = true;
    script.src = this.prepareUrl() + query;
    script.onerror = function () {
      self.onClose();
    };

    var insertAt = document.getElementsByTagName('script')[0];
    insertAt.parentNode.insertBefore(script, insertAt);
    this.script = script;

    if (indicator) {
      setTimeout(function () {
        var iframe = document.createElement('iframe');
        document.body.appendChild(iframe);
        document.body.removeChild(iframe);
      }, 100);
    }
  };

  /**
   * Callback function for the incoming message stream from the Socket.IO server.
   *
   * @param {String} data The message
   * @api private
   */

  JSONPPolling.prototype._ = function (msg) {
    this.onData(msg);
    if (this.isOpen) {
      this.get();
    }
    return this;
  };

  /**
   * The indicator hack only works after onload
   *
   * @param {Socket} socket The socket instance that needs a transport
   * @param {Function} fn The callback
   * @api private
   */

  JSONPPolling.prototype.ready = function (socket, fn) {
    var self = this;
    if (!indicator) return fn.call(this);

    io.util.load(function () {
      fn.call(self);
    });
  };

  /**
   * Checks if browser supports this transport.
   *
   * @return {Boolean}
   * @api public
   */

  JSONPPolling.check = function () {
    return 'document' in global;
  };

  /**
   * Check if cross domain requests are supported
   *
   * @returns {Boolean}
   * @api public
   */

  JSONPPolling.xdomainCheck = function () {
    return true;
  };

  /**
   * Add the transport to your public io.transports array.
   *
   * @api private
   */

  io.transports.push('jsonp-polling');

})(
    'undefined' != typeof io ? io.Transport : module.exports
  , 'undefined' != typeof io ? io : module.parent.exports
  , this
);

if (typeof define === "function" && define.amd) {
  define([], function () { return io; });
}
})();(function () {
    "use strict";

/**
 * The CommandManager object provides infrastructure for command processing within Nitrogen. Commands are messages that are issued
 * with the intent of changing the state of a principal in the system. The CommandManager's role is to watch that principal's message
 * stream and effect state changes on the device it is managing based on these commands and their context in the stream. The CommandManager
 * is always subclassed into a class that handles a specific type of command. This subclass is responsible for providing a set of functions
 * that define how the message stream should be interpreted and acted on: executeActiveCommands, isRelevant, isCommand, obsoletes. See each
 * function in this class for more information on what an implementation of these functions should provide.
 *
 * An example of how a SwitchManager subclass is used to control a light in a device application looks like this:
 *
 * service.connect(light, function(err, session, light) {
 *     if (err) return console.log('failed to connect light: ' + err);
 *
 *     var switchManager = new nitrogen.SwitchManager(light);
 *     switchManager.start(session, { $or: [ { to: light.id }, { from: light.id } ] }, function(err) {
 *        if (err) return console.log('switchManager failed to start: ' + err);
 *     });
 * });
 *
 * @class CommandManager
 * @namespace nitrogen
 */

function CommandManager(device) {
    this.device = device;
    this.executing = false;
    this.messageQueue = [];
}

/**
 * Returns the array of commands that are currently active for this manager.  This is typically used to execute them during executeQueue.
 *
 * @method activeCommands
 * @returns {Array of Messages} Array of active command messages.
 **/

CommandManager.prototype.activeCommands = function() {
    var filtered = [];
    this.messageQueue.forEach(function(message) {
        if (message.millisToTimestamp() <= 0) {
            filtered.push(message);
        }
    });

    return filtered;
};

CommandManager.prototype.commandFilter = function() {
    return {
        tags: CommandManager.commandTag(this.device.id)
    };
};

CommandManager.commandTag = function(principalId) {
    return "command:" + principalId;
};

/**
 * Reduce the current message queue to the set of active commands by obsoleting completed and
 * expired commands.
 *
 * @method collapse
 **/

CommandManager.prototype.collapse = function() {
    var collapsedMessages = [];
    var upstreamMessage;
    var self = this;

    this.sortQueue();

    // first, strip all non relevant messages.
    var relevantMessages = [];
    this.messageQueue.forEach(function(message) {
        if (self.isRelevant(message)) {
            relevantMessages.push(message);
        }
    });

    // dequeue the first message in the message queue leaving only the downstream messages...
    while ((upstreamMessage = relevantMessages.shift())) {
        if (self.isCommand(upstreamMessage)) {
            var idx;
            var obsoleted = false;
            for (idx=0; idx < relevantMessages.length && !obsoleted; idx++) {
                var downstreamMessage = relevantMessages[idx];
                obsoleted = this.obsoletes(downstreamMessage, upstreamMessage);
            }

            if (!obsoleted) {
                collapsedMessages.push(upstreamMessage);
                // console.log('collapse: message: ' + upstreamMessage.from + '->' + upstreamMessage.to + ' not obsolete, ');
            } else {
                // console.log('collapse: message: ' + upstreamMessage.from + '->' + upstreamMessage.to + ' has been obsoleted, removing.');
            }
        } else {
            // console.log('collapse: message: ' + upstreamMessage.from + '->' + upstreamMessage.to + ' is type: ' + upstreamMessage.type + ': removing.');
        }
    }

    this.messageQueue = collapsedMessages;
};

/**
 * Executes the currently active command queue.  If the next command's timestamp occurs in the future,
 * setup a timeout to retry then.
 *
 * @method execute
 * @private
 **/

CommandManager.prototype.execute = function() {
    var self = this;

    if (this.device.id !== this.session.principal.id) return self.session.log.debug('CommandManager::execute: not in session of device, skipping execution.');
    if (this.executing) return; // self.session.log.debug('CommandManager::execute: already executing command, skipping execute. current queue: ' + JSON.stringify(this.messageQueue));
    if (!this.messageQueue || this.messageQueue.length === 0) return self.session.log.debug('CommandManager::execute: empty command queue.');

    var msToExecute = this.messageQueue[0].millisToTimestamp();
    if (msToExecute > 0) {
        self.session.log.debug('CommandManager::execute: top message occurs in the future, setting timeout for ' + msToExecute + 'ms.');
        return setTimeout(function() { self.execute(); }, msToExecute);
    }

    this.executing = true;
    this.executeQueue(function(err) {
        self.executing = false;
        if (err) self.session.log.error('CommandManager::execute: execution error: ' + err);

        // set up a new execution pass on the command queue.
        setTimeout(function() { self.execute(); }, 0);
    });
};

/**
 * Executes the active commands in the message queue. Should be implemented by subclasses of CommandManager.
 *
 * Commands that have reached this point have been passed the start filter (see the CommandManager.start() method details),
 * had a "true" result out of the CommandManager.isRelevant and CommandManager.isCommand methods and finally has recieved a "false"
 * to the CommandManager.obsoletes method.
 *
 * An example use of this from the Simple Device guide:
 *
 * SimpleLEDManager.prototype.executeQueue = function(callback) {
 *     var self = this;
 *
 *     // If you don't have a device, throw an error.
 *     if (!this.device) return callback(new Error('no device attached to control manager.'));
 *
 *     var activeCommands = this.activeCommands();
 *     if (activeCommands.length === 0) {
 *         this.session.log.warn('SimpleLEDManager::executeQueue: no active commands to execute.');
 *         return callback();
 *     }
 *
 *     // We will take all of the activeCommand's ids and use pass them to the "response_to".
 *     // This is important for the "obsoletes" method.
 *     var commandIds = [];
 *     activeCommands.forEach(function(activeCommand) {
 *        commandIds.push(activeCommand.id);
 *     });
 *
 *     // Create the status response
 *     var message = new nitrogen.Message({
 *         type: '_myStatusResponse',
 *         tags: nitrogen.CommandManager.commandTag(self.device.id),
 *         body: {
 *             command: {
 *                 message: "My status is good"
 *             }
 *         },
 *         response_to: commandIds
 *     });
 *
 *     message.send(_session, function(err, message) {
 *         if (err) return callback(err);
 *
 *         // Let the command manager know we processed this _lightOn message by passing it the _isOn message.
 *         self.process(new nitrogen.Message(message));
 *
 *         // Need to callback if there aren't any issues so commandManager can proceed.
 *         return callback();
 *      });
 *    }
 *
 * @method executeQueue
 **/

/**
 * Return true if this message is relevant to the CommandManager. Should be implemented by subclasses of CommandManager.
 *
 * This works in concert with the filter passed into the server in the start method. It enables more intricate processing and
 * filtering than the simple filter. It is also possible that you could just return true on the method if your filter is correct and you
 * don't want to filter out additional messages. For example:
 *
 * MyCommandManager.prototype.isRelevant = function(message) {
 *    return (message.body.property === "value I'm looking for");
 * };
 *
 * @method isRelevant
 * @param {Object} message The message to test for relevance.
 **/

/**
 * Return true if this message is a command that this CommandManager can process. Should be implemented by subclasses of CommandManager.
 *
 * For example:
 *
 * MyCommandManager.prototype.isCommand = function(message) {
 *    return message.is('_myCommandName');
 * };
 *
 * @method isCommand
 * @param {Object} message The message to test to see if it is a relevant command.
 **/

/**
 * Return the last active command in the message queue as ordered by timestamp.
 *
 * @method lastActiveCommand
 **/

CommandManager.prototype.lastActiveCommand = function() {
    var activeCommands = this.activeCommands();
    return activeCommands.length > 0 ? activeCommands[activeCommands.length - 1] : null;
};

/**
 * Returns true if the given message upstream in time of the given downstream message is obsoleted by
 * the downstream message. Should be overridden by subclasses to provide command type specific
 * obsoletion logic.  Overrides should start their implementation by calling this function for base
 * functionality.
 *
 * For example:
 *
 * MyCommandManager.prototype.obsoletes = function(downstreamMsg, upstreamMsg) {
 *     if (nitrogen.CommandManager.obsoletes(downstreamMsg, upstreamMsg))
 *         return true;
 *
 *     var value = downstreamMsg.is("_myStatusResponse") &&
 *                 downstreamMsg.isResponseTo(upstreamMsg) &&
 *                 upstreamMsg.is("_myStatusRequest");
 *
 *     return value;
 * };
 *
 * @method obsoletes
 * @param {Object} downstreamMsg The downstream message that potentially obsoletes the upstream message.
 * @param {Object} upstreamMsg The upstream message that is potentially obsoleted by the downstream message.
 **/

CommandManager.obsoletes = function(downstreamMsg, upstreamMsg) {
    if (downstreamMsg.ts < upstreamMsg.ts) return false;
    if (downstreamMsg.expired()) return false;
    if (upstreamMsg.expired()) return true;

    return false;
};

/**
 * Process new message in this principal's message stream:  adds it to the messageQueue, collapses the
 * current message stream, and sets up timeout to handle expiration of this message and the subsequent
 * collapse that should occur.
 *
 * @method process
 * @param {Object} message The new message to process.
 * @private
 **/

CommandManager.prototype.process = function(message) {
    if (!this.isRelevant(message)) return;

    this.messageQueue.push(message);
    this.collapse();

    var self = this;

    if (message.expires) {
        var nextExpiration = Math.max(message.millisToExpiration(), 0);

        setTimeout(function() { self.collapse(); }, nextExpiration);
    }
};

CommandManager.prototype.sortQueue = function() {
    this.messageQueue.sort(function(a,b) {
        return a.ts - b.ts;
    });
};

/**
 * Starts command processing on the message stream using the principal's session. It fetches all the
 * current messages, processes them, and then starts execution. It also establishes a subscription to
 * handle new messages and automatically executes them as they are received.
 *
 * The filter specified is passed to the service as both a query and subscription and should specify a bound on the messages you'd like
 * to receive.  By default, it uses a commandFilter (as defined in commandFilter) which is a tag applied to messages that are "command relevant"
 * for this device. and is an opt in model for messages that you want to recieve. You can further filter out messages if you like but this can handle
 * nearly all cases. In the case that you can't specify a perfect filter, you can further filter the message stream by subclassing the
 * "isRelevant" function.
 *
 * In the most common case, your implementation of start in your CommandManager subclass should look like this:
 *
 * MyCommandManager.prototype.start = function(session, callback) {
 *    return nitrogen.CommandManager.prototype.start.call(this, session, null, callback);
 * };
 *
 * @method start
 * @param {Object} session Session this CommandManager should operate under.
 * @param {Object} filter Filter for relevant messages for this CommandManager.  This is usually specified by the CommandManager subclass.
 * @param {Object} callback Callback of the form f(err, message).  Called after each new message received.
 **/

CommandManager.prototype.start = function(session, filter, callback) {
    this.session = session;

    // if no custom filter is passed, use a command query.
    if (!filter) {
        filter = this.commandFilter();
    }

    var self = this;
    Message.find(session, filter, { sort: { ts: -1 }, limit: 1000 }, function(err, reversedMessages) {
        if (err) return callback(err);

        var messages = reversedMessages.reverse();

        // collapse the message stream down to the just the active commands.
        messages.forEach(function(message) { self.process(message); });

        self.execute();

        session.onMessage(filter, function(message) {
            self.process(message);
            callback(null, message);

            // if we aren't currently executing anything, kickstart execution.
            if (!self.executing) {
                self.execute();
            }
        });

        session.log.info('commandManager: started.');
        callback();
    });
};

/**
 * An ApiKey in Nitrogen is a key that enables non-user principals to be created in the system.
 *
 * A permission has the following properties:
 *     owner: The principal id that owns this api key.
 *     key: The opaque key that should be used by the client as the api_key on requests
 * @class ApiKey
 * @namespace nitrogen
 **/

function ApiKey(json) {
    for(var key in json) {
        if(json.hasOwnProperty(key)) {
            this[key] = json[key];
        }
    }
}

/**
 * Find all the api_keys for the authenticated user.
 *
 * @method index
 * @async
 * @param {Object} session An open session with a Nitrogen service. Only user principals will return results.
 * @param {Object} query A query filter for the apiKeys defined using MongoDB's query format.  (reserved: currently ignored)
 * @param {Object} options Options for the query (reserved, currently ignored):  'limit': maximum number of results to be returned. 'sort': The field that the results should be sorted on, 'dir': The direction that the results  should be sorted. 'skip': The number of results that should be skipped before pulling results.
 * @param {Function} callback Callback function of the form f(err, permissions).
 **/

ApiKey.find = function(session, query, options, callback) {
    if (!session) return callback(new Error("Session required for ApiKey.index."));
    if (!callback || typeof callback !== 'function') return callback(new Error('Callback required for ApiKey.index.'));

    session.get({
        url: session.service.config.endpoints.api_keys,
        json: true
    }, function(err, resp, body) {
        if (err) return callback(err);

        var apiKeys = body.api_keys.map(function(apiKey) {
            return new ApiKey(apiKey);
        });

        callback(null, apiKeys);
    });
};

/**
 * Create an API key.
 *
 * @method create
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, apiKey).
 **/

ApiKey.prototype.create = function(session, callback) {
    var self = this;

    session.post({ url: session.service.config.endpoints.api_keys, json: this }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(body.error || resp.statusCode);

        return callback(null, new ApiKey(body.api_key));
    });
};

/**
 * A permission in Nitrogen is a grant that has been made to principal(s) for a particular set of actions on another principal.
 *
 * A permission has the following properties:
 *     issued_to: The principal id that this permission is granted to.  If missing, this permission applies to all principals.
 *     principal_for: The principal this permission is for.  For instance, if you were granting subscription access for a lamp to a user,
 *         in this scenario the lamp would be the principal_for.
 *     action: The action that this permission is relevant for.  Valid values include:
 *         'admin': issued_to is authorized to perform administrative operations on principal_for.
 *         'send': issued_to is authorized to send messages to principal_for.
 *         'subscribe': issued_to is authorized to subscribe to messages from principal_for.
 *         'view': issued_to is authorized to see principal_for in searches.
 *     authorized: Boolean declaring if matches to this permission authorizes or forbids it.
 *     priority: The priority this principal has in relation to other permissions.  Permissions are walked in priority order and the first
 *         match is used to determine if the action is authorized.
 *     filter: An object that specifies additional filters that should be applied to a relevant object at authorization time.  For example,
 *         { type: "ip" } would be used to limit matches with this permission to only messages with the type 'ip'.
 *     expires: An expiration date for this permission. After this expiration date, the permission will be disregarded and eventually removed
 *          from the system.
 * @class Permission
 * @namespace nitrogen
 **/

function Permission(json) {
    for(var key in json) {
        if(json.hasOwnProperty(key)) {
            this[key] = json[key];
        }
    }
}

/**
 * Creates a permission with the Nitrogen service.
 *
 * @method create
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, permission).
 **/

Permission.prototype.create = function(session, callback) {
    session.post({ url: session.service.config.endpoints.permissions, json: this }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(body);

        if (callback) callback(null, new Permission(body.permission));
    });
};

/**
 * Find permissions filtered by the passed query and limited to and sorted by the
 * passed options.
 *
 * @method find
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} query A query using MongoDB query format.
 * @param {Object} options Options for the query:  'limit': maximum number of results to be returned. 'sort': The field that the results should be sorted on, 'dir': The direction that the results  should be sorted. 'skip': The number of results that should be skipped before pulling results.
 * @param {Function} callback Callback function of the form f(err, permissions).
 **/

Permission.find = function(session, query, options, callback) {
    if (!session) return callback(new Error("session required for find"));
    if (!callback || typeof callback !== 'function') return callback(new Error('callback required for find.'));

    session.get({
        url: session.service.config.endpoints.permissions,
        query: query,
        queryOptions: options,
        json: true
    }, function(err, resp, body) {
        if (err) return callback(err);

        var permissions = body.permissions.map(function(permission) {
            return new Permission(permission);
        });

        callback(null, permissions);
    });
};

/**
 * Delete this permission from the service.
 *
 * @method remove
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err).
 **/

Permission.prototype.remove = function(session, callback) {
    var self = this;

    session.remove({ url: session.service.config.endpoints.permissions + "/" + this.id }, function(err) {
        return callback(err);
    });
};

/**
 * Save this permission to the service.
 *
 * @method save
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, permission).
 **/

Permission.prototype.save = function(session, callback) {
    if (!this.id) return callback("Permission must have id to be saved.");

    session.put({ url: session.service.config.endpoints.permissions + "/" + this.id, json: this }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(body, null);

        if (callback) callback(null, new Permission(body.permission));
    });
};

Permission.NORMAL_PRIORITY = 10000000;


/**
 * @class Principal
 * Test
**/

function Principal(json) {
    this.updateAttributes(json);

    if (!this.nickname) this.nickname = 'default';
}

/**
 * A Principal in Nitrogen represents entities with authentication privileges in Nitrogen.  Applications, devices,
 * and services are all examples of principals.
 **/

Principal.DEVICE_SECRET_BYTES = 128;

/**
 * @method authenticate
 * @async
 *
 * Authenticate this principal with the service.  The mechanism used to authenticate depends on
 * the type of principal. For users, an email and password is used.  For all other principals,
 * public key auth will be used.
 *
 * @param {Object} config The config for the Nitrogen service to auth against.
 * @param {Function} callback Callback function of the form f(err, principal, accessToken).
 **/

Principal.prototype.authenticate = function(config, callback) {
    var self = this;

    var authBody = { type: this.type, id: this.id };
    var headers = {};

    if (this.is('user')) {
        authBody.email = this.email;
        authBody.password = this.password;
    } else {
        authBody.secret = this.secret;
    }

    var path;
    if (this.is('user')) {
        path = "/user/auth";
    } else {
        path = "/secret/auth";
    }

    request.post({ url: config.endpoints.principals + path, headers: headers, json: authBody }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode !== 200) {
            return callback(JSON.stringify(body.error) || resp.statusCode);
        }

        self.updateAttributes(body.principal);

        return callback(null, self, body.accessToken);
    });
};

/**
 * Fetch an accessToken for the passed principal.
 *
 * @method accessTokenFor
 * @async
 * @param {Object} session The session with a Nitrogen service to make this request under.
 * @param {Object} options Options for the access token: 'expires': the date this access token should expire.
 * @param {Function} callback Callback function of the form f(err, messages).
 **/

Principal.accessTokenFor = function(session, principalId, options, callback) {
    if (!session) return callback('no session passed to Principal.accessTokenFor');
    if (!callback || typeof(callback) !== 'function') return callback('no callback passed to to Principal.accessTokenFor.');

    var accessTokenUrl = session.service.config.endpoints.principals + "/accesstoken";

    options.principal_id = principalId;

    session.post({
        url: accessTokenUrl,
        json: options
    }, function(err, resp, body) {
        if (err) return callback(err);

        callback(null, body.accessToken);
    });
};

/**
 * Create a new principal with the service.  For user principal types, this principal must have a email, password, and
 * name.
 *
 * @method create
 * @async
 * @param {Object} config The config data for the Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, principal, accessToken).
 **/

var Base64={_keyStr:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=",encode:function(e){var t="";var n,r,i,s,o,u,a;var f=0;e=Base64._utf8_encode(e);while(f<e.length){n=e.charCodeAt(f++);r=e.charCodeAt(f++);i=e.charCodeAt(f++);s=n>>2;o=(n&3)<<4|r>>4;u=(r&15)<<2|i>>6;a=i&63;if(isNaN(r)){u=a=64}else if(isNaN(i)){a=64}t=t+this._keyStr.charAt(s)+this._keyStr.charAt(o)+this._keyStr.charAt(u)+this._keyStr.charAt(a)}return t},decode:function(e){var t="";var n,r,i;var s,o,u,a;var f=0;e=e.replace(/[^A-Za-z0-9\+\/\=]/g,"");while(f<e.length){s=this._keyStr.indexOf(e.charAt(f++));o=this._keyStr.indexOf(e.charAt(f++));u=this._keyStr.indexOf(e.charAt(f++));a=this._keyStr.indexOf(e.charAt(f++));n=s<<2|o>>4;r=(o&15)<<4|u>>2;i=(u&3)<<6|a;t=t+String.fromCharCode(n);if(u!=64){t=t+String.fromCharCode(r)}if(a!=64){t=t+String.fromCharCode(i)}}t=Base64._utf8_decode(t);return t},_utf8_encode:function(e){e=e.replace(/\r\n/g,"\n");var t="";for(var n=0;n<e.length;n++){var r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r)}else if(r>127&&r<2048){t+=String.fromCharCode(r>>6|192);t+=String.fromCharCode(r&63|128)}else{t+=String.fromCharCode(r>>12|224);t+=String.fromCharCode(r>>6&63|128);t+=String.fromCharCode(r&63|128)}}return t},_utf8_decode:function(e){var t="";var n=0;var r=c1=c2=0;while(n<e.length){r=e.charCodeAt(n);if(r<128){t+=String.fromCharCode(r);n++}else if(r>191&&r<224){c2=e.charCodeAt(n+1);t+=String.fromCharCode((r&31)<<6|c2&63);n+=2}else{c2=e.charCodeAt(n+1);c3=e.charCodeAt(n+2);t+=String.fromCharCode((r&15)<<12|(c2&63)<<6|c3&63);n+=3}}return t}}

Principal.prototype.create = function(config, callback) {
    var self = this,
        nCrypto = (crypto && crypto.randomBytes) ? crypto : {};

    if (!nCrypto.randomBytes) {
      var browserCrypto = window.crypto || window.msCrypto;
      nCrypto.randomBytes = function (size, cb) {
        var bytes = new Uint8Array(size); 

        browserCrypto.getRandomValues(bytes);
        if (typeof cb === 'function') {
          cb(null, bytes);
        }
        return bytes;
      }
    }

    nCrypto.randomBytes(Principal.DEVICE_SECRET_BYTES, function(err, secretBuf) {
        if (err) return callback(err);

        var secretBase64 = Base64.encode(secretBuf.toString()); //secretBuf.toString('base64');
        console.log(secretBase64);
        if (self.is('user') && (!self.email || !self.password || !self.name)) {
            return callback(new Error("Please provide your full name, email, and password to create an account."));
        } else if (!self.is('user')) {
            if (!self.api_key && config.api_key) self.api_key = config.api_key;
            if (!self.api_key) return callback(new Error('Parameter api_key required for principal.create'));

            self.secret = secretBase64;
        }

        var principalObject = JSON.parse(JSON.stringify(self));

        request.post({
            url: config.endpoints.principals,
            json: principalObject
        }, function(err, resp, body) {
            if (err) return callback(err);
            if (resp.statusCode !== 200) return callback(body.error || resp.statusCode);

            // reinject the secret
            body.principal.secret = secretBase64;

            self.updateAttributes(body.principal);

            return callback(null, self, body.accessToken);
        });
    });
};

/**
 * Find principals filtered by the passed query and limited to and sorted by the passed options.
 *
 * @method find
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} query A query filter for the principals defined using MongoDB's query format.
 * @param {Object} options Options for the query:  'limit': maximum number of results to be returned. 'sort': The field that the results should be sorted on, 'dir': The direction that the results  should be sorted. 'skip': The number of results that should be skipped before pulling results.
 * @param {Function} callback Callback function of the form f(err, principals).
 **/

Principal.find = function(session, query, options, callback) {
    if (!session) return callback(new Error('Principal.findById requires active session.'));

    var principalsUrl = session.service.config.endpoints.principals;
    session.get({
        url: principalsUrl,
        query: query,
        queryOptions: options,
        json: true
    }, function(err, resp, body) {
        if (err) return callback(err);

        var principals = body.principals.map(function(principal) {
            return new Principal(principal);
        });

        callback(null, principals);
    });
};

/**
 * Find a principal by id.
 *
 * @method findById
 * @param {Object} session An open session with a Nitrogen service.
 * @param {String} principalId The principal id to search for.
 * @param {Function} callback Callback function of the form f(err, principal, accessToken).
 **/

Principal.findById = function(session, principalId, callback) {
    if (!session) return callback(new Error('Principal.findById requires active session.'));

    var principalsUrl = session.service.config.endpoints.principals + "/" + principalId;
    session.get({ url: principalsUrl, json: true }, function(err, resp, body) {
        if (err) return callback(err);

        callback(null, new Principal(body.principal));
    });
};

/**
 * Impersonate a principal using another principal's session.  This is used by the service to
 * impersonate a particular principal for application execution.
 *
 * @method impersonate
 * @param {Object} session An open session with a Nitrogen service.
 * @param {String} principalId The principal id to impersonate.
 * @param {Function} callback Callback function of the form f(err, principal, accessToken).
 **/

Principal.impersonate = function(session, principalId, callback) {
    var self = this;
    var impersonateUrl = session.service.config.endpoints.principals + "/impersonate";
    session.post({ url: impersonateUrl, json: { id: principalId } }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(body.error || resp.statusCode);

        var receivedPrincipal = new Principal(body.principal);

        // preserve the nickname for storage
        receivedPrincipal.nickname = self.nickname;

        return callback(null, receivedPrincipal, body.accessToken);
    });
};

/**
 * Delete this principal from the service.
 *
 * @method remove
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err).
 **/

Principal.prototype.remove = function(session, callback) {
    var self = this;

    session.remove({ url: session.service.config.endpoints.principals + "/" + this.id }, function(err) {
        if (err) return callback(err);

        session.service.clearCredentials(self);

        return callback();
    });
};

/**
 * Resume a session using a stored accessToken (attached to this principal).
 *
 * @method resume
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, principal, accessToken).
 **/

Principal.prototype.resume = function(config, callback) {
    // Just create session, handle failure on first usage if accessToken is invalid.

    return callback(null, this, this.accessToken);
};

/**
 * Save this principal to the service.
 *
 * @method save
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, principal).
 **/

Principal.prototype.save = function(session, callback) {
    if (!this.id) return callback("Principal must have id to be saved.");
    var self = this;

    Principal.update(session, this.id, this, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(resp.statusCode, null);

        self.updateAttributes(body.principal);

        if (callback) callback(null, self);
    });
};

/**
 * Report the status of this principal.  Principal subclasses should override this method if there
 * is meaningful status that they can provide.  This status is included in the principal's heartbeat
 * to the Nitrogen service.
 *
 * By default this implementation simply makes a no status callback.
 *
 * @method status
 * @param {Function} callback Callback function of the form f(err, status).
 **/

Principal.prototype.status = function(callback) {
    // nop by default, principal subclasses should override if there is a meaningful status they can provide.
    callback(null, {});
};

Principal.prototype.toStoreId = function() {
    if (!this.nickname) console.log("WARNING: nickname is not defined for device.");

    return "principal." + this.nickname;
};

Principal.prototype.toStoreObject = function() {
    return {
        id: this.id,
        api_key: this.api_key,
        email: this.email,
        type: this.type,
        public_key: this.public_key,
        private_key: this.private_key,
        secret: this.secret
    };
};

/**
 * Performs a partial update of a principal.
 *
 * @method update
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} id The id of the principal to update.
 * @param {Object} updates The update to apply to this principal.
 * @param {Function} callback Callback function of the form f(err, resp, body).
 **/

Principal.update = function(session, id, updates, callback) {
    session.put({ url: session.service.config.endpoints.principals + "/" + id, json: updates }, callback);
};

Principal.prototype.updateAttributes = function(attributes) {
    for(var key in attributes) {
        this[key] = attributes[key];
    }
};

Principal.prototype.is = function(type) {
    return this.type === type;
};

/**
 * The Message object is the core of the Nitrogen framework.  Applications, devices, and
 * services use Messages to communicate with and issue commands to each other. All messages
 * that don't begin with an unscore are checked against a schema chosen by the messages 'type'
 * and 'schema_version' fields such that a message of a given type is known to conform to a
 * particular structure.   This enables sharing between differing devices and applications.  For
 * custom message types, an application may use an unscore prefix (eg. '_myMessage') with any
 * schema that they'd like.  This supports communication between principals of the same
 * organization over a private schema.  That said, it is strongly encouraged to use standard
 * schemas wherever possible.
 *
 * Messages have a sender principal (referred to as 'from') and a receiver principal (referred
 * to as 'to'). These fields are used to route messages to their receiver.
 *
 * Message types are divided into two main classes: data and commands.  Data messages carry
 * information, typically the output of a device's operation.  For example, a message typed
 * 'image' contains an image url in its body in its 'url' property.
 *
 * The second class of messages are commands. Command messages are sent from one principal to
 * another to request an operation on the receiving principal.  For example, a message of the
 * type 'cameraCommand' contains a command that directs the operation of a camera principal.
 *
 * @class Message
 * @namespace nitrogen
 */

function Message(json) {
    this.ts = new Date();
    this.body = {};

    for(var key in json) {
        if(json.hasOwnProperty(key)) {
            if (key === 'ts' || key === 'expires' || key === 'index_until')
                this[key] = new Date(Date.parse(json[key]));
            else
                this[key] = json[key];
        }
    }
}

/**
 * Find messages filtered by the passed query and limited to and sorted by the passed options.
 *
 * @method find
 * @async
 * @param {Object} session The session with a Nitrogen service to make this request under.
 * @param {Object} query A query filter for the messages you want to find defined using MongoDB query format.
 * @param {Object} options Options for the query:  'limit': maximum number of results to be returned. 'sort': The field that the results should be sorted on, 'dir': The direction that the results  should be sorted. 'skip': The number of results that should be skipped before pulling results.
 * @param {Function} callback Callback function of the form f(err, messages).
 **/

Message.find = function(session, query, options, callback) {
    if (!session) return callback('no session passed to Message.find');
    if (!callback || typeof(callback) !== 'function') return callback('no callback passed to Message.find.');
    if (!query) query = {};
    if (!options) options = {};

    var messageUrl = session.service.config.endpoints.messages;
    session.get({
        url: messageUrl,
        query: query,
        queryOptions: options,
        json: true
    }, function(err, resp, body) {
        if (err) return callback(err);

        var messages = body.messages.map(function(message) {
            return new Message(message);
        });

        callback(null, messages);
    });
};

/**
 * Returns true if the message is of the passed type.
 *
 * @method is
 * @param {String} type Message type to compare against.
 * @returns {Boolean} Returns true if the message is of the passed type.
 **/

Message.prototype.is = function(type) {
    return this.type === type;
};

/**
 * Returns true if the message is from the passed principal.
 *
 * @method isFrom
 * @param {String} principalId Principal id to compare against.
 * @returns {Boolean} Returns true if the message is from the passed principal id.
 **/

Message.prototype.isFrom = function(principal) {
    return this.from === principal.id;
};

/**
 * Returns true if the message is in response to the passed message.
 *
 * @method isResponseTo
 * @param {String} type Message to compare against.
 * @returns {Boolean} Returns true if the message is in response to the passed message.
 **/

Message.prototype.isResponseTo = function(otherMessage) {
    return otherMessage.id && this.response_to && this.response_to.indexOf(otherMessage.id) !== -1;
};

/**
 * Returns true if the message is of the passed type.
 *
 * @method isTo
 * @param {String} principalId Principal id to compare against.
 * @returns {Boolean} Returns true if the message is of the passed type.
 **/

Message.prototype.isTo = function(principal) {
    return this.to === principal.id;
};

/**
 * Removes a set of messages specified by passed filter. Used by the internal service principal to
 * to cleanup expired messages etc.
 *
 * @method remove
 * @async
 * @static
 * @private
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} query A query filter for the messages you want to remove.
 * @param {Function} callback Callback function of the form f(err, removedCount).
 */

Message.remove = function(session, query, callback) {
    session.remove({
        url: session.service.config.endpoints.messages,
        query: query,
        json: true
    }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(resp.statusCode);

        callback(null, body.removed);
    });
};

/**
 * Remove this message. Used by the internal service principal for cleanup.
 *
 * @method remove
 * @async
 * @private
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, removedCount).
 **/

Message.prototype.remove = function(session, callback) {
    Message.remove(session, { "_id": this.id }, callback || function() {});
};

/**
 * Send this message.
 *
 * @method send
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Function} callback Callback function of the form f(err, sentMessages).
 **/

Message.prototype.send = function(session, callback) {
    Message.sendMany(session, [this], callback || function() {});
};

/**
 * Send multiple messages.
 *
 * @method sendMany
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Array} messages An array of messages to send.
 * @param {Function} callback Callback function of the form f(err, sentMessages).
 **/

Message.sendMany = function(session, messages, callback) {
    if (!session) return callback('session required for Message.sendMany');

    var self = this;

    Message.queuedMessages.push({
        session: session,
        messages: messages,
        callback: callback
    });

    Message.setupSendTimeout();
};

// TODO: there is an efficiency opportunity here to combine messages sent over the same session into one request.
//
// Challenges:
//          - Would need to do accounting around callbacks to make sure they are all called with the right messages.
//          - How do you handle the case where there is a 400 in one of the blocks but not in another.

Message.backoffMillis = 1;

Message.sendQueue = function() {
    Message.sendTimeout = null;

    var context = Message.queuedMessages[0];
    Message.queuedMessages = Message.queuedMessages.slice(1);

    context.session.post({ url: context.session.service.config.endpoints.messages, json: context.messages }, function(err, resp, body) {
        if (resp && resp.statusCode !== 200) {
            err = err || body.message || resp.statusCode;

            // bad request responses are fatal, otherwise requeue and try again.
            if (resp.statusCode !== 400)
                Message.queuedMessages.unshift(context);
        }

        if (err) {
            Message.backoffMillis *= 4;
            Message.backoffMillis = Math.min((64 + Math.random()) * 1000, Message.backoffMillis)
        } else {
            Message.backoffMillis = 1;
        }

        // if we still have messages in the queue after all of this, set up the next process.
        if (Message.queuedMessages.length) {
            Message.setupSendTimeout();
        }

        if (err) {
            context.session.log.error('sending message failed with error: ' + JSON.stringify(err));
            if (context.callback) context.callback(err);
            return;
        }

        var sentMessages = [];
        body.messages.forEach(function(messageJson) {
            sentMessages.push(new Message(messageJson));
        });

        if (context.callback) context.callback(null, sentMessages);
    });
};

Message.setupSendTimeout = function() {
    var self = this;

    if (!Message.sendTimeout) {
        Message.sendTimeout = setTimeout(function() { self.sendQueue(); }, Message.backoffMillis);
    }
};

Message.queuedMessages = [];
Message.sendTimeout = null;

/**
 * Returns true if the message expired.
 *
 * @method expired
 * @returns {Boolean} Returns true if the message is expired.
 **/

Message.prototype.expired = function() {
    return this.millisToExpiration() < 0;
};

/**
 * Returns the number of milliseconds before this message expires.
 *
 * @method millisToExpiration
 * @returns {Number} Number of milliseconds before this message expires.
 **/

Message.prototype.millisToExpiration = function() {
    return this.expires - new Date().getTime();
};

/**
 * Returns the number of milliseconds before the timestamp for this message.  Used to calculate
 * time to execution for command messages.
 *
 * @method millisToTimestamp
 * @returns {Number} Number of milliseconds before the timestamp for this message.
 **/

Message.prototype.millisToTimestamp = function() {
    return this.ts - new Date().getTime();
};

Message.NEVER_EXPIRE  = new Date(Date.UTC(2500, 0, 1));
Message.INDEX_FOREVER = new Date(Date.UTC(2500, 0, 1));

/**
 * A Blob represents a binary data object that is stored with the Nitrogen service.
 *
 * @class Blob
 * @namespace nitrogen
 */

function Blob(json) {
    for(var key in json) {
        this[key] = json[key];
    }
}

/**
 * Saves a blob via streaming to the Nitrogen service.
 *
 * @method save
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} stream A stream with the contents of the blob.
 * @param {Function} callback Callback function of the form f(err, blob).
 **/

Blob.prototype.save = function(session, stream, callback) {
    if (!session.service.config.endpoints.blobs) return callback("blob endpoint not available on this service");

    var self = this;

    stream.pipe(
        session.post({ url: session.service.config.endpoints.blobs,
                       headers: { 'Content-Type': self.content_type } }, function (err, resp, body) {

            if (err) return callback(err);
            if (resp.statusCode != 200) return callback(resp.statusCode);

            var bodyJson = JSON.parse(body);

            return callback(null, new Blob(bodyJson.blob));
        })
    );
};

/**
 * Fetches a blob from the Nitrogen service.
 *
 * @method get
 * @async
 * @param {Object} session An open session with a Nitrogen service.
 * @param {Object} url The url for the blob.
 * @param {Function} callback Callback function of the form f(err, httpResponse, blobData).
 **/

Blob.get = function(session, url, callback) {
    session.get({ url: url, encoding: null }, callback);
};


/**
 * A Session represents an authenticated session and subscription connection between a principal and a service.
 *
 * @class Session
 * @namespace nitrogen
 * @param {Object} service The service this session is associated with.
 * @param {Object} principal The principal this session is associated with.
 * @param {Object} accessToken The accessToken to use for authenticating requests with this session.
 * @param {Object} socket The subscription socket to use for realtime updates.
 */

function Session(service, principal, accessToken) {
    var self = this;

    this.service = service;
    this.principal = principal;
    this.accessToken = accessToken;

    this.subscriptionCount = 0;
    this.sessionId = Math.floor(Math.random()*100000000);

    this.heartbeatTimeout = false;
    this.heartbeatReceived = true;
    this.consecutiveHeartbeatFailures = 0;

    this.subscriptions = {};
    this.failureCallback = function() {};

    Session.prototype.log = {};
    Session.prototype.log.debug = function(message) { Session.log(self, "debug", message); };
    Session.prototype.log.info = function(message)  { Session.log(self, "info", message);  };
    Session.prototype.log.warn = function(message)  { Session.log(self, "warn", message);  };
    Session.prototype.log.error = function(message) { Session.log(self, "error", message); };

    this.log.debug('session: created.');
}

Session.HEARTBEAT_DEFAULT_INTERVAL = 5 * 60 * 1000; // ms
Session.MAX_SUBSCRIPTION_RESTARTS = 3;
Session.HEARTBEAT_TIMEOUT = 15 * 1000; // ms

Session.queryStringFromObject = function(obj) {
    var str = [];

    for(var p in obj)
        str.push(encodeURIComponent(p) + "=" + encodeURIComponent(obj[p]));

    return str.join("&");
};


Session.startSession = function(service, principal, accessToken) {
    if (!Session.sessions)
        Session.sessions = {};

    if (!Session.sessions[principal.id]) {
        Session.sessions[principal.id] = new Session(service, principal, accessToken);
    }

    return Session.sessions[principal.id];
};

Session.stopSession = function(session) {
    delete Session.sessions[session.principal.id];
};

/**
 * Stop the session with the service.
 *
 * @method stop
 * @private
 **/

Session.prototype.stop = function() {
    Session.stopSession(this);
    this.failureCallback = null;

    var self = this;
    for (var key in this.subscriptions) {
        this.disconnectSubscription(this.subscriptions[key].id);
    }

    if (this.socket)
        this.socket.disconnect();

    this.socket = null;

    if (this.heartbeat)
        this.heartbeat.stop();

    this.heartbeat = null;
};

Session.prototype.beforeRequest = function(options) {
    if (!options.headers) options.headers = {};
    options.headers.Authorization = "Bearer " + this.accessToken.token;

    var prefix = "?";
    if (options.query) {
        var queryString = JSON.stringify(options.query);
        options.url += prefix + "q=" + encodeURIComponent(queryString);
        delete options.query;

        prefix = "&";
    }

    if (options.queryOptions) {
        var optionsString = JSON.stringify(options.queryOptions);
        options.url += prefix + "options=" + encodeURIComponent(optionsString);
        delete options.queryOptions;
    }
};

Session.prototype.afterRequest = function(err, resp, body, callback) {
    if (resp && resp.statusCode !== 200) {
        if (body && body.error)
            err = body.error;
        else
            err = resp.statusCode;
    }

    if (resp && resp.statusCode === 401) this.signalFailure();

    // If we get an access token update, replace the current access token and continue.
    if (resp && resp.headers && resp.headers['x-n2-set-access-token']) {
        this.accessToken = JSON.parse(resp.headers['x-n2-set-access-token']);
    }

    callback(err, resp, body);
};

Session.prototype.makeRequest = function(options, requestFunc, callback) {
    var self = this;

    this.beforeRequest(options);

    return requestFunc(options, function(err, resp, body) {
        self.afterRequest(err, resp, body, callback);
    });
};

Session.prototype.get = function(options, callback) {
    return this.makeRequest(options, request.get, callback);
};

Session.prototype.post = function(options, callback) {
    return this.makeRequest(options, request.post, callback);
};

Session.prototype.put = function(options, callback) {
    return this.makeRequest(options, request.put, callback);
};

Session.prototype.remove = function(options, callback) {
    return this.makeRequest(options, request.del, callback);
};

/**
 * Clear all of the credentials for a particular principal.
 *
 * @method clearCredentials
 * @private
 * @param {Object} principal The principal to clear credentials for.
 **/

Session.prototype.clearCredentials = function() {
    this.service.clearCredentials(this.principal);
};

/**
 * Connect subscription socket for principal with this accessToken to the service.
 *
 * @method connectSocket
 * @private
 **/

Session.prototype.connectSocket = function() {
    var self = this;
    if (!this.principal || !this.principal.id || !this.accessToken) throw new Error('need both principal and accessToken to connectSocket');

    // we can only share a socket on a per principal basis because otherwise principals can listen in
    // on other principals' events.
    if (!this.socket) {
        this.socket = io.connect(this.service.config.endpoints.subscriptions, {
            query: Session.queryStringFromObject({ auth: this.accessToken.token }),
            'force new connection': true
        });

        this.setupSocketEvents();
        self.startHeartbeat();
    }

    return this.socket;
};

Session.prototype.setupSocketEvents = function() {
    var self = this;

    //this.socket.on('connecting', function() { self.log.debug('session: socket.io connecting'); });

    this.socket.on('connect', function() {
        self.log.debug('session: socket.io connected');
    });

    this.socket.on('disconnect', function() {
        self.log.debug('session: socket.io connection disconnected');
    });

    // this.socket.on('reconnecting', function() { self.log.info('session: socket.io connection reconnecting'); });

    this.socket.on('reconnect', function() {
        if (self.socket) {
            self.log.warn('session: socket.io connection reconnected.  restarting subscriptions: ' + JSON.stringify(self.subscriptions));
            self.restartSubscriptions();
        }
    });
};

/**
 * Disconnect the current subscription connection with the service.
 *
 * @method disconnectSubscription
 * @private
 **/

Session.prototype.disconnectSubscription = function(subscriptionId) {
    if (!this.subscriptions[subscriptionId]) return;

    this.socket.emit('stop', this.subscriptions[subscriptionId]);
    delete this.subscriptions[subscriptionId];
};

/**
 * Connect a subscription with the service.
 *
 * @method disconnectSubscription
 * @private
 **/

Session.prototype.connectSubscription = function(options) {
    this.subscriptions[options.id] = options;
    this.socket.emit('start', options);
};

/**
 * Restart all subscriptions with the service.  Used after a connection disruption.
 *
 * @method restartSubscriptions
 * @private
 **/

Session.prototype.restartSubscriptions = function() {
    for (var key in this.subscriptions) {
        var subscription = this.subscriptions[key];
        this.log.info('restarting subscription: ' + key + ': ' + JSON.stringify(subscription));

        if (this.socket) this.socket.emit('stop', this.subscriptions[subscription.id]);
        this.connectSubscription(this.subscriptions[key]);
    }
};

/**
 * Impersonate the principal with the authorization context of this session.  Used by the Nitrogen service to impersonate principals for agent setup.
 *
 * @method impersonate
 * @private
 * @param {Object} principal The principal to impersonate with this session.
 * @param {Object} callback Callback for the impersonation.
 *   @param {Object} callback.err If the impersonation failed, this will contain the error.
 *   @param {Object} callback.session The session for the impersonated principal with this service.
 *   @param {Object} callback.principal The impersonated principal.
 **/

Session.prototype.impersonate = function(principal, callback) {
    this.service.impersonate(this, principal, callback);
};

// DEPRECIATED
Session.prototype.onAuthFailure = function(callback) {
    this.failureCallback = callback;
};

/**
 * Passed callback function will be called on session failure.
 *
 * @method onFailure
 * @param {Object} principal The principal to impersonate with this session.
 * @param {Function} callback Callback function with signature f(err).
 **/

Session.prototype.onFailure = function(callback) {
    this.failureCallback = callback;
};

Session.prototype.signalFailure = function() {
    var failureCallback = this.failureCallback;

    this.stop();

    if (failureCallback) failureCallback();
};

/**
 * Core subscription event method. Primarily used to subscribe for changes to principals and new messages.
 *
 * @method on
 * @param {Object} options Options for the filter of the messages this subscription should receive: 'type': The type this subscription should receive.  Only 'message' is currently supported. 'filter': The filter to apply to the objects returned from this subscription.  For example { from: '51f2735fda5fcca439000001' } will restrict messages received to only those from this particular principal id.
 * @param {Function} callback Callback function with signature f(objectReceived).
 **/

Session.prototype.on = function(options, callback) {
    if (!options) return callback("Options hash required for subscription");
    if (['message', 'principal'].indexOf(options.type) === -1) return callback("Unknown subscription 'type'");

    // if there is an existing socket connection already, this will be a NOP.
    this.connectSocket();

    this.subscriptionCount += 1;
    options.id = this.principal.id + "_" + this.sessionId + "_" + this.subscriptionCount;

    this.socket.on(options.id, function(obj) {
        if (options.type === 'message')
            return callback(new Message(obj));

        if (options.type === 'principal')
            return callback(new Principal(obj));
    });

    this.connectSubscription(options);
    return options.id;
};

/**
 * Syntax sugar to setup a message subscription.
 *
 * @method onMessage
 * @param {Object} filter The filter to apply to the objects returned from this subscription.  For example { from: '51f2735fda5fcca439000001' } will restrict messages received to only those from this particular principal id.
 * @param {Function} callback Callback function with signature f(messageReceived).
 **/

Session.prototype.onMessage = function(filter, callback) {
    if (typeof filter === 'function') {
        callback = filter;
    }

    var options = {};
    options.filter = filter || {};
    options.type = 'message';
    return this.on(options, callback);
};

/**
 * Syntax sugar to setup a principal subscription.
 *
 * @method onMessage
 * @param {Object} filter The filter to apply to the objects returned from this subscription.  For example { from: '51f2735fda5fcca439000001' } will restrict messages received to only those from this particular principal id.
 * @param {Function} callback Callback function with signature f(messageReceived).
 **/

Session.prototype.onPrincipal = function(filter, callback) {
    if (typeof filter === 'function') {
        callback = filter;
    }

    var options = {};
    options.filter = filter || {};
    options.type = 'principal';
    return this.on(options, callback);
};

Session.log = function(session, severity, message) {
    if (session.service.config.log_levels && session.service.config.log_levels.indexOf(severity) === -1) return;

    var logLifetime = session.service.config.log_lifetime || 24 * 60 * 60000;

    var logMessage = new Message({
        type: 'log',
        ts: new Date(),
        from: session.principal.id,
        body: {
            severity: severity,
            message: message
        },
        index_until: new Date(new Date().getTime() + logLifetime)
    });

    var principalNameOrId = (session.principal.name || session.principal.id);

    var dateFormat = [logMessage.ts.getMonth()+1, logMessage.ts.getDate(), logMessage.ts.getFullYear()];
    var date = dateFormat.join('/');

    console.log(date + " " + logMessage.ts.toLocaleTimeString() + ": " + principalNameOrId + ': ' + severity + ": " + message);

    logMessage.send(session);
};

Session.prototype.heartbeatReceivedCheck = function() {
    if (!this.heartbeatReceived) {
        this.consecutiveHeartbeatFailures += 1;
        this.log.error('heartbeat: not received within timeout: restarting subscriptions (' + this.consecutiveHeartbeatFailures + ' consecutive).');
        if (this.session && this.consecutiveHeartbeatFailures < Heartbeat.MAX_SUBSCRIPTION_RESTARTS) {
            this.stopHeartbeat();
            this.restartSubscriptions();
            this.startHeartbeatInterval();
        } else {
            // too many consecutive heartbeat failures

            this.log.error('heartbeat: too many consecutive failures. signalling session failure.');
            this.signalFailure();
        }
    }
};

Session.prototype.startHeartbeat = function() {
    if (this.heartbeatTimeout) return;
    var self = this;

    this.onMessage({ type: 'heartbeat' }, function(message) {
        // the goal of this is to test realtime connectivity so we don't care whose heartbeat this is.

        self.log.debug('received heartbeat');
        self.heartbeatReceived = true;
        self.consecutiveHeartbeatFailures = 0;
    });

    this.startHeartbeatInterval();
};

Session.prototype.startHeartbeatInterval = function() {
    var self = this;

    this.stopHeartbeat();

    this.log.debug('starting heartbeat interval');

    this.heartbeatTimeout = setInterval(function() {
        self.sendHeartbeat();
    }, Session.HEARTBEAT_DEFAULT_INTERVAL);
};

Session.prototype.sendHeartbeat = function(callback) {
    var self = this;

    this.principal.status(function(err, status) {
        if (err) {
            status = status || {};
            status.error = err;
        }

        var heartbeatIndexUntil = self.service.config.heartbeat_lifetime || 30 * 60 * 1000;

        var message = new Message({
            type: 'heartbeat',
            public: false,
            body: {
                error: !!err,
                status: status
            },
            index_until: new Date(new Date().getTime() + heartbeatIndexUntil)
        });

        setTimeout(function() { self.heartbeatReceivedCheck() }, Session.HEARTBEAT_TIMEOUT);
        self.heartbeatReceived = false;

        self.log.debug('sending heartbeat');
        message.send(self, function(err, message) {
            if (err) {
                self.log.error("failed to send heartbeat: " + err);

                // something is far more wrong than the subscription.
                self.heartbeatReceived = true;
                if (self) self.signalFailure();
            }

            if (callback) return callback(err);
        });
    });
};

Session.prototype.stopHeartbeat = function() {
    if (!this.heartbeatTimeout) return;

    this.log.debug('clearing heartbeat interval');

    clearInterval(this.heartbeatTimeout);
    this.heartbeatTimeout = false;
};


/**
 * A Service is a Nitrogen endpoint that a Session is established against for interactions with
 * it.  How that Session is established depends on the Principal type. For device and service
 * principals, authentication is done based on a shared secret between the device and the
 * service.  For user principals, authentication is via email and password. Sessions can also
 * be resumed if the principal has stored an authToken. The Service object is also responsible
 * for querying the headwaiter endpoint to fetch the service endpoints that this Session should
 * use.
 *
 * @class Service
 * @namespace nitrogen
 **/

function Service(config) {
    this.config = config || {};

    if (!this.config.store) this.config.store = new MemoryStore();

    this.config.host = this.config.host || 'api.nitrogen.io';
    this.config.protocol = this.config.protocol || 'https';
    this.config.http_port = this.config.http_port || 443;
    this.config.max_session_lifetime = Service.MAX_SESSION_LIFETIME_DEFAULT;

    this.config.base_url = this.config.protocol + "://" + this.config.host + ":" + this.config.http_port + "/api/v1";

    if (!this.config.endpoints) this.config.endpoints = {};

    for (var key in config.endpoints) {
        this.config.endpoints[key] = config.endpoints[key];
    }

    if (!this.config.endpoints.headwaiter) {
        this.config.endpoints.headwaiter = this.config.base_url + "/headwaiter";
    }

    // Need this for password reset.  Can be overridden by response from headwaiter.
    if (!this.config.endpoints.principals) {
        this.config.endpoints.principals = this.config.base_url + "/principals";
    }

    this.store = config.store;
}

Service.BACKOFF_RATE_MILLIS = 500;
Service.MAXIMUM_BACKOFF_STEPS = 7;

Service.MAX_SESSION_LIFETIME_DEFAULT = 24 * 60 * 60 * 1000; // ms

/**
 * Authenticate this principal with the Nitrogen service.  The mechanism used to authenticate
 * depends on the type of principal. For users, an email and password is used. For other principals
 * public key encryption is verify a signed nonce value for authentication.
 *
 * @method authenticate
 * @async
 * @param {Object} principal The principal to authenticate with this service. The principal should include the email/password for a user principal or the private_key for other principal types.
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.authenticate = function(principal, callback) {
    this.authenticateSession(principal, principal.authenticate, callback);
};

/**
 * Creates the principal with this service.
 *
 * @method create
 * @async
 * @param {Object} principal The principal to create with this service. It should include email/password for user principal types.
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.create = function(principal, callback) {
    this.authenticateSession(principal, principal.create, callback);
};

/**
 * Attempts to resume a session for this principal using a saved accessToken.
 *
 * @method resume
 * @async
 * @param {Object} principal The principal to resume the session with this service.
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.resume = function(principal, callback) {
    if (!this.store) return callback(new Error('No store configured with service.'));

    this.authenticateSession(principal, principal.resume, function(err, session, principal) {
        if (err) return callback(err);

        Principal.findById(session, principal.id, function(err, loadedPrincipal) {
            if (err) return callback(err);

            loadedPrincipal.nickname = principal.nickname;
            return callback(err, session, loadedPrincipal);
        });
    });
};

/**
 * Connect attempts to authenicate the principal with the service. If the principal
 * isn't provisioned with the service, it automatically creates the principal with the
 * service.
 *
 * @method connect
 * @async
 * @param {Object} principal The principal to connect with this service.
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.connect = function(principal, callback) {
    var self = this;

    this.store.get(principal.toStoreId(), function(err, storedPrincipal) {
        if (storedPrincipal) {
            principal.updateAttributes(storedPrincipal);
            self.restartOnFailureAuthWrapper(principal, principal.authenticate, callback);
        } else {
            self.restartOnFailureAuthWrapper(principal, principal.create, callback);
        }
    });
};

function asyncWhilst(test, iterator, callback) {
    if (test()) {
        iterator(function (err) {
            if (err) {
                return callback(err);
            }
            asyncWhilst(test, iterator, callback);
        });
    } else {
        callback();
    }
}

Service.prototype.restartOnFailureAuthWrapper = function(principal, initialOp, sessionCallback) {
    var self = this;
    var authOp = initialOp;

    asyncWhilst(
        function() { return true; },
        function(restartCallback) {
            self.authOpWithRetry(principal, authOp, function(err, session, principal) {
                if (err) return sessionCallback(err);

                session.onFailure(function() {
                    session.log.error('session failure:  restarting');
                    session.stop();

                    authOp = principal.authenticate;
                    return restartCallback();
                });

                return sessionCallback(err, session, principal);
            });
        },
        function(err) {
            // should never get here
        }
    );
};

Service.prototype.authOpWithRetry = function(principal, authOperation, callback) {

    var self = this;
    var failures = 0;
    var successful = false;

    var backoffMillis = 0;

    var err;
    var session;

    asyncWhilst(
        function () { return !successful; },
        function (retryCallback) {

            if (backoffMillis > 0.0)
                console.log('service: retrying auth request after backoff of ' + backoffMillis + ' ms.');

            setTimeout(function() {
                self.authenticateSession(principal, authOperation, function(e, s, p) {
                    successful = !e;
                    err = e;

                    if (!successful) {
                        console.log('service: authentication failed: ' + JSON.stringify(err));

                        failures += 1;
                        console.log('service: ' + failures + ' consecutive auth failures.');

                        var backoffAmount = Math.min(failures, Service.MAXIMUM_BACKOFF_STEPS);

                        backoffMillis = Math.pow(2, backoffAmount) * Service.BACKOFF_RATE_MILLIS * (1 + Math.random());
                        backoffMillis = Math.floor(backoffMillis);
                    } else {
                        session = s;
                        principal = p;
                    }

                    return retryCallback();
                });

            }, backoffMillis);
        },
        function (e) {
            return callback(err, session, principal);
        }
    );
};

/**
 * Internal method to run all the common steps of authentication against a Nitrogen service.
 *
 * @method authenticateSession
 * @async
 * @private
 * @param {Object} principal The principal to connect with this service.
 * @param {Object} authOperation The authorization method on the principal that is used to .
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.authenticateSession = function(principal, authOperation, callback) {
    var self = this;

    this.configure(principal, function(err, config) {
        if (err) return callback(err);

        self.config = config;

        if (self.config.log_levels && self.config.log_levels.indexOf('debug')) console.log('service: configured.');

        authOperation.bind(principal)(self.config, function(err, principal, accessToken) {
            if (err) return callback(err);

            if (!principal) return callback(new Error("authentication failed: no principal returned"));
            if (!accessToken) return callback(new Error("authentication failed: no accessToken returned"));

            if (self.config.log_levels && self.config.log_levels.indexOf('debug') !== -1) console.log('principal: authenticated.');

            if (principal.claim_code) {
                console.log('This principal (' + principal.id + ') can be claimed using code: ' + principal.claim_code);
            }

            self.store.set(principal.toStoreId(), principal.toStoreObject(), function(err) {
                if (err) return callback(err);

                var session = Session.startSession(self, principal, accessToken);

                if (self.config.max_session_lifetime)
                    setInterval(function() { session.onFailure(); }, config.max_session_lifetime);

                callback(null, session, principal);
            });
        });
    });
};

/**
 * Impersonate a principal using the passed session
 *
 * @method impersonate
 * @async
 * @param {Object} session The session to use to authorize this impersonation
 * @param {Object} principal The principal to impersonate with this service.
 * @param {Function} callback Callback function with signature f(err, session, principal).
 **/

Service.prototype.impersonate = function(session, principalId, callback) {
    var self = this;

    Principal.impersonate(session, principalId, function(err, impersonatedPrincipal, accessToken) {
        if (err) return callback(err);

        impersonatedPrincipal.accessToken = accessToken;

        var impersonatedSession = Session.startSession(self, impersonatedPrincipal, accessToken);

        // configure the impersonatedPrincipal session in case the principal has a different config.
        self.configure(impersonatedPrincipal, function(err, config) {
            if (err) return callback(err);

            impersonatedSession.service.config = config;
            callback(null, impersonatedSession, impersonatedPrincipal);
        });
    });
};

/**
 * Fetch the endpoint configuration for this service for this user. Before authenticating a principal, we first
 * ask the service to return the set of endpoints that we should for this principal to talk to the Nitrogen service.  Note,
 * this might actually not be the same service, as Nitrogen may redirect clients to a different service or different endpoints.
 *
 * @method configure
 * @async
 * @private
 * @param {Object} config The default configuration to use to connect to Nitrogen.
 * @param {Object} principal The principal to use configure this service.
 * @param {Function} callback Callback function with signature f(err, configuration).
 **/

Service.prototype.configure = function(principal, callback) {
    var self = this;
    var headwaiter_url = this.config.endpoints.headwaiter;

    if (principal) {
        if (principal.is('user') && principal.email) {
            headwaiter_url += "?email=" + principal.email;
        } else if (principal.id) {
            headwaiter_url += "?principal_id=" + principal.id;
        }
    }

    request.get({ url: headwaiter_url, json: true }, function(err, resp, body) {
        if (err) return callback(err);
        if (resp.statusCode != 200) return callback(JSON.stringify(body.error) || resp.statusCode);

        for (var key in body.endpoints) {
            self.config.endpoints[key] = body.endpoints[key];
        }

        self.config.nonce = body.nonce;

        callback(null, self.config);
    });
};

/**
 * Clear all of the credentials for a particular principal.
 *
 * @method clearCredentials
 * @private
 * @param {Object} principal The principal to clear credentials for.
 **/

Service.prototype.clearCredentials = function(principal) {
    if (!this.store) return;

    this.store.delete(principal.toStoreId());
};


/**
 * Device is a subclass of principal that houses all device specific principal functionality.
 *
 * @class Device
 * @namespace nitrogen
 */

function Device() {
    Principal.apply(this, arguments);

    this.type = 'device';
}

Device.prototype = Object.create(Principal.prototype);
Device.prototype.constructor = Device;


/**
 * User is a subclass of principal that houses all user specific principal functionality.
 *
 * @class User
 * @namespace nitrogen
 */

function User() {
    Principal.apply(this, arguments);

    this.type = 'user';
}

User.prototype = Object.create(Principal.prototype);
User.prototype.constructor = User;

function MemoryStore() {
    this.clear();
}

MemoryStore.prototype.clear = function(callback) {
    this.store = {};
    if (callback) return callback();
};

MemoryStore.prototype.get = function(key, callback) {
    return callback(null, this.store[key]);
};

MemoryStore.prototype.set = function(key, value, callback) {
    this.store[key] = value;
    if (callback) return callback();
};

MemoryStore.prototype.delete = function(key, callback) {
    delete this.store[key];
    if (callback) return callback();
};

window.nitrogen = {
  ApiKey: ApiKey,
  Blob: Blob,
  CommandManager: CommandManager,
  Device: Device,
  Message: Message,
  Permission: Permission,
  Principal: Principal,
  Service: Service,
  Session: Session,
  User: User
};
}());