// vi:ts=4 sw=4 noet:

/*jsl:option explicit*/

/** @constructor */

var HADES = {};

HADES._construct = function()
{

/***************************************************************************
 * Connection
 */

function /* class */ Connection(session, id, host, port) {

	/**
	 * Event handlers
	 */
	this.onerror = function(self, error, msg) {};
	this.onrecv = function(self, data) {};
	this.onstatechange = function(self, state) {};

	this._session = session;
	this._id = id;
	this._host = host;
	this._port = port;
	this.state = 0; /* STATE.DISCONNECTED */
}

Connection.STATE = {
	DISCONNECTED: 0,
	CONNECTING: 1,
	CONNECTED: 2,
	DISCONNECTING: 3
};

Connection.prototype = function() {
	return {
		constructor: Connection,

		toString: function()
		{
			return this._host + ":" + this._port;
		},

		getId: function()
		{
			return this._id;
		},

		getSession: function()
		{
			return this._session;
		},

		send: function(data)
		{
			this._session.send(this, data);
		},

		error: function(code, msg)
		{
			this.onerror(this, code, msg);
		},

		setState: function(state)
		{
			this.state = state;
			this.onstatechange(this, state);
		}
	};
}();


/***************************************************************************
 * Session
 */

function /* class */ Session(host, port) {

	/********************
	 * Public interface
	 */

	/* Event handlers */
	this.onerror = function(self, code, msg) {};
	this.onrecv = function(self, data) {};
	this.onstatechange = function(self, state) {};

	this.state = 0; /* STATE.DISCONNECTED */
	this.error = 0; /* ERROR.NO_ERROR */
	this.errorText = "";

	/**
	 * Current XHR request used for streaming in.
	 */
	this._recvReq = null;
	this._relayHost = null;
	this._relayPort = null;

	/**
	 * Base URI of the proxy.
	 */
	this._sessionUri = null;

	/**
	 * Enqueued post actions.
	 */
	this._actionQueue = [];

	/**
	 * Timeout used to check the XHR responseText for new packets.
	 */
	this._checkTimeout = null;

	/**
	 * Connected stream id, if any.
	 */
	this._sessionId = null;

	/**
	 * Start of next packet in recv stream.
	 */
	this._recvIdx = 0;

	/**
	 * Whether or not to poll for every packet.
	 */
	this._longPoll = false;

	this._localPoll = false;

	this._lastPacket = null;

	this._currentPost = null;

	this._unloadListener = null;

	this._recvTimeout = null;

	this._longPoll = false;

	this._localPoll = false;

	this._relayHost = host;
	this._relayPort = port;

	this._connections = {};

	if(!host)
	{
		if(!document.domain)
		{
			this._relayHost = "localhost";
		}
		else
		{
			this._relayHost = document.domain;
		}
	}

	if(!port)
	{
		if(!document.location.port)
		{
			this._relayPort = 1234;
		}
		else
		{
			this._relayPort = document.location.port;
		}
	}
}

/**
 * Public class variables.
 */

Session.STATE = {
	DISCONNECTED: 0,
	CONNECTING: 1,
	CONNECTED: 2,
	DISCONNECTING: 7
};

Session.ERROR = {
	NO_ERROR: 0,
	INITIALIZATION_FAILED: 1,
	SHUTDOWN_FAILED: 2,
	CONNECT_FAILED: 3,
	DISCONNECT_FAILED: 4,
	SEND_FAILED: 5,
	RECV_FAILED: 6
};

/**
 * Not attached to XMLHttpRequest because this seems to confuse opera.
 */
var XHR = {
	DISCONNECTED: 0,
	LOADING: 1,
	LOADED: 2,
	INTERACTIVE: 3,
	COMPLETED: 4
};

var MSXML_VERSIONS =
	["Msxml2.XMLHTTP.6.0", "Msxml2.XMLHTTP.3.0", "Msxml2.XMLHTTP"];

var using_XMLHTTP = false;

var callbackExceptionsBroken = false /*@cc_on || @_jscript_version < 5.7 @*/;

Session.prototype = function() {

	/**
	 * Private class constants.
	 */

	var PACKET = {
		CONNFAIL: 0,
		CONNECTED: 1,
		DISCONNECTED: 2,
		DATA: 3,
		PAD: 4,
		TAKEOVER: 5,
		RECONN: 6,
		DELETED: 7
	};

	/**
	 * Private methods.
	 */

	//var debug = function() { console.debug.apply(console, arguments); };
	var debug = function(){};
	var info = function() { console.info.apply(console, arguments); };
	var warn = function() { console.warn.apply(console, arguments); };
	var error = function() { console.error.apply(console, arguments); };
	var assert = function() { console.assert.apply(console, arguments); };

	function fatal(obj)
	{
		var ex;
		var msg;

		if(obj instanceof Error)
		{
			msg = obj.message;
			ex = obj;
		}
		else
		{
			try
			{
				msg = msg.toString();
			}
			catch(e)
			{
				msg = typeof msg;
			}
			ex = new Error(msg);
		}

		if (callbackExceptionsBroken) 
		{
			window.alert("Fatal error: " + msg);
		}
		else
		{
			error(ex.message);
			throw ex;
		}
	}

	function bind(obj, method)
	{
		var args = Array.prototype.slice.call(arguments, 2);

		return function()
		{
			var args2 = args.concat(Array.prototype.slice.call(arguments));
			try {
				method.apply(obj, args2);
			} catch(e) {
				console.error(e);
				fatal(e);
			}
		};
	}

	function createXHR()
	{
		if(typeof XMLHttpRequest == "undefined")
		{	
			for(var idx in MSXML_VERSIONS)
			{
				try
				{
					var name = MSXML_VERSIONS[idx];
					var ret = new ActiveXObject(name);
					using_XMLHTTP = name;
					debug("Using ActiveXObject(" + name + ")");
					return ret;
				}
				catch(e)
				{
				}
			}

			throw new Error("This browser does not support XMLHttpRequest.");
		}
		else
		{
			return new XMLHttpRequest;
		}
	}

	function isXDR(req)
	{
		assert(req);

		if(typeof XDomainRequest == 'undefined')
		{
			return false;
		}

		return !!req.onprogress;
	}

	function clearRequest(req)
	{
		assert(req, "req");

		if(using_XMLHTTP)
		{
			req.onreadystatechange = function() {};
		}
		else
		{
			req.onreadystatechange = null;
			req.onload = null;
			req.onabort = null;
			req.onerror = null;
			req.onprogress = null;
			req.ontimeout = null;
		}

		if(req.abort)
		{
			try { req.abort(); } catch(e) {}
		}
	}

	function enumToStr(en, value)
	{
		for(var str in en)
		{
			if(en[str] == value)
			{
				return str;
			}
		}
		return value;
	}

	/**
	 * Portable function to attach an event listener.
	 */
	function addListener(obj, ev, func) 
	{
		var bound = null;

		if(obj.addEventListener)
		{
			debug("Attaching listener to " + ev + " event using addEventListener");
			obj.addEventListener(ev, func, false);
			return func;	
		}
		else if(obj.attachEvent)
		{
			debug("Attaching listener to " + ev + " event using attachEvent");
			bound = bind(obj, func);
			obj.attachEvent('on' + ev, bound);
			return bound;
		}
		else
		{
			debug("Attaching listener to " + ev + " event using DOM0");
			assert(!obj['on' + ev], "!obj['on' + ev]");
			bound = bind(obj, func);
			obj['on' + ev] = bound;
			return bound;
		}
	}

	function removeListener(obj, ev, func)
	{
		if(obj.removeEventListener)
		{
			debug("Detaching listener from " + ev + " event using removeEventListener");
			obj.removeEventListener(ev, func, false);
		}
		else if(obj.detachEvent)
		{
			debug("Detaching listener from " + ev + " event using detachEvent");
			obj.detachEvent('on' + ev, func);
		}
		else
		{
			debug("Detaching listener from " + ev + " event using DOM0");
			assert(obj['on' + ev] == func, "obj['on' + ev] == func");
			obj['on' + ev] = null;
		}
	}

	return {

		constructor: Session,

		/***************************************************************************
		 * Public methods
		 */

		cleanup: function()
		{
			debug("Cleaning up - clearing public callbacks");

			this.onerror = function(self, code, msg) {};
			this.onrecv = function(self, data) {};
			this.onstatechange = function(self, state) {};

			debug("Clearing private callbacks");

			if(this._unloadListener)
			{
				try { removeListener(window, "beforeunload", this._unloadListener); } catch(e) {}
				this._unloadListener = null;
			}
			if(this._recvTimeout)
			{
				try { window.clearTimeout(this._recvTimeout); } catch(e) {}
				this._recvTimeout = null;
			}
			if(this._checkTimeout)
			{
				try { window.clearTimeout(this._checkTimeout); } catch(e) {}
				this._checkTimeout = null;
			}

			debug("Clearing requests");

			if(this._currentPost)
			{
				clearRequest(this._currentPost);
				this._currentPost = null;
			}
			if(this._recvReq)
			{
				clearRequest(this._recvReq);
				this._recvReq = null;
			}

			while(this._actionQueue.length > 0)
			{
				var item = this._actionQueue.shift();
				clearRequest(item.req);
				item.req = null;
			}
		},
				
		connect: function(host, port)
		{
			assert(this instanceof Session, "this instanceof Session");	

			debug("connect() called");

			if(this.state != Session.STATE.CONNECTED)
			{
				throw new Error("Session.connect() called during session state " + enumToStr(this.state));
			}

			var cid = null;

			do {
				cid = Math.floor(Math.random() * (1 << 30));
			} while(cid in this._connections);

			this.enqConnect(cid, host, port);

			var conn = new Connection(this, cid, host, port);
			this._connections[cid] = conn;
			return conn;
		},

		send: function(conn, data)
		{
			assert(this instanceof Session, "this instanceof Session");	
			assert(conn, "conn not null");
			assert(data, "data not null");

			var connState = conn.state;

			debug("send(" + window.escape(data) + ")");

			if(connState != Session.STATE.CONNECTED)
			{
				throw new Error("Session.send() called during connection state " + enumToStr(connState));
			}

			this.enqSend(conn, data);		
		},

		disconnect: function(conn)
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(conn, "conn not null");

			var connState = conn.getState();

			if(connState != Session.STATE.CONNECTED)
			{
				throw new Error("Session.disconnect() called during connection state " + enumToStr(connState));
			}

			this.enqDisconnect(conn);
		},
		
		shutdown: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			if(this.state != Session.STATE.CONNECTED &&
				this.state != Session.STATE.DISCONNECTED)
			{
				throw new Error("Session.close() called during state " + enumToStr(this.state));
			}

			this.enqShutdown();						 
		},

		/***************************************************************************
		 * Semi-private methods
		 */

		init: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			debug("init() called");

			if(typeof Firebug != "undefined")
			{
				warn("FirebugLite detected - using long poll mode");
				this._longPoll = true;
			}
			else
			{
				if(typeof ActiveXObject != "undefined" && typeof XDomainRequest == "undefined")
				{
					debug("ActiveX but not XDR detected - using long poll mode");
					this._longPoll = true;
				}
				if(typeof opera != "undefined")
				{
					debug("Opera detected - using local poll mode");
					this._localPoll = true;
				}
			}

			if(this.state != Session.STATE.DISCONNECTED)
			{
				throw new Error("Session.init() called during state " + enumToStr(this.state));
			}

			this._sessionUri = "http://" + this._relayHost + ":" + this._relayPort + "/session";
			this.create();
			this._unloadListener = addListener(window, "beforeunload", bind(this, this.cleanup));
		},

		makeXHR: function(method, url, async)
		{			
			assert(this instanceof Session, "this instanceof Session");

			url += (url.match(/\?/) ? "&" : "?") + "ts=" + (new Date()).getTime();

			debug("Constructing XHR with url " + url);

			var req = createXHR();

			/*req.url = url;*/

			/*req.setRequestHeader("Cache-Control", "no-store,no-cache,must-revalidate");
			 req.setRequestHeader("Pragma", "no-cache");
			 req.setRequestHeader("Expires", "-1");*/

			req.open(method, url, async);

			assert(req.readyState == XHR.LOADING, "req.readyState == XHR.LOADED"); 

			return req;
		},

		checkProgress: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			assert(this._recvReq);

			if(!this._localPoll)
			{
				debug("checkProgress() called");
			}

			if(this._localPoll && this._sessionId)
			{
				this._checkTimeout = window.setTimeout(bind(this, this.checkProgress), 100);
			}

			if(!this._localPoll)
			{
				assert(this._recvReq, "this._recvReq");
			}

			if(!isXDR(this._recvReq))
			{
				assert(this._recvReq.readyState == XHR.INTERACTIVE || this._recvReq.readyState == XHR.COMPLETED, "this._recvReq.readyState == XHR.INTERACTIVE || this._recvReq.readyState == XHR.COMPLETED");
			}

			var responseText = this._recvReq.responseText;

			try
			{
				if(!this._recvReq.responseText)
				{
					return;
				}
			}
			catch(e)
			{
				return;
			}

			for(;;)
			{
				var headerLength = 5 + 2 + 16 + 8;

				if(responseText.length < this._recvIdx + headerLength)
				{
					return;
				}

				debug(responseText);

				var header = responseText.substr(this._recvIdx, headerLength);

				debug("HEADER: " + header);

				var magicString = header.substr(0,5);
				debug("MAGIC: " + magicString);

				var packetTypeStr = header.substr(5,2);
				debug("PACKET: " + packetTypeStr);
				var packetType = parseInt("0x" + packetTypeStr, 16);

				var connectionIdStr = header.substr(5+2, 16);
				debug("CID: " + connectionIdStr);
				var connectionId = parseInt("0x" + connectionIdStr, 16);

				var payloadLengthStr = header.substr(5+2+16, 8);
				debug("PAYLOAD: " + payloadLengthStr);
				var payloadLength = parseInt("0x" + payloadLengthStr, 16);

				debug("header=" + header);
				debug("packetType=" + enumToStr(PACKET, packetType));
				debug("payloadLength=" + payloadLength);
				debug("connectionId=" + connectionId);

				var conn = null;
				if(connectionId in this._connections)
				{
					debug("Found connection with id " + connectionId);
					conn = this._connections[connectionId];
					debug("Connection: " + conn.toString());
				}
				else
				{
					 debug("Connection not known");
				}

				if(isNaN(packetType) || 
				   isNaN(payloadLength) || 
				   isNaN(connectionId))
				{
					if(isNaN(packetType)) 
					{
						info("packedType is NaN");
					}

					if(isNaN(payloadLength)) 
					{
						info("payloadLength is NaN");
					}

					if(isNaN(connectionId)) 
					{
						info("connectionId is NaN");
					}

					/* XXX */
					clearRequest(this._recvReq);
					return;
				}

				if(responseText.length < this._recvIdx + headerLength + payloadLength)
				{
					info("Waiting for more response");
					return;
				}

				debug("Received packet of type " + enumToStr(PACKET, packetType) + " with payload length " + payloadLength);

				if(packetType != PACKET.PAD)
				{
					this._lastPacket = packetType;
				}
				
				
				if(packetType != PACKET.DELETED && 
				   packetType != PACKET.PAD &&
				   !conn)
				{
					if(connectionId === 0)
					{
						console.error("Received non-PAD packet for unknown connection " + connectionId);
					}
					else
					{
						console.error("Received non-PAD packet for unknown connection " + connectionId);
					}
					this._recvIdx += headerLength + payloadLength;
					return;
				}

				var payload = responseText.substr(this._recvIdx + headerLength, payloadLength);

				if(packetType == PACKET.CONNFAIL)
				{
					conn.setState(Connection.STATE.DISCONNECTED);
				}
				else if(packetType == PACKET.CONNECTED)
				{
					conn.setState(Connection.STATE.CONNECTED);
				}
				else if(packetType == PACKET.DISCONNECTED)
				{
					conn.setState(Connection.STATE.DISCONNECTED);
				}
				else if(packetType == PACKET.DATA)
				{
					conn.onrecv(conn, payload);
				}
				else if(packetType == PACKET.DELETED)
				{
					debug("Setting state to DISCONNECTED");
					this.state = Session.STATE.DISCONNECTED;
					// XXX: Disconnect connections first
					this._sessionId = null;
					this.onstatechange(this, this.state);
				}
				this._recvIdx += headerLength + payloadLength;			
			}

		},

		handleRecvStateChange: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			assert(!isXDR(this._recvReq), "!isXDR(this._recvReq)");

			debug("handleRecvStateChange() called, readyState=" + this._recvReq.readyState);

			if(this._recvReq.readyState == XHR.INTERACTIVE)
			{
				if(this._longPoll)
				{
					return;
				}

				if(this._recvReq.status == 200)
				{
					this.checkProgress();
				}
			}
			else if(this._recvReq.readyState == XHR.COMPLETED)
			{
				if(this._checkTimeout)
				{
					window.clearTimeout(this._checkTimeout);
				}

				if(this._recvReq.status == 200)
				{
					this.handleRecvLoad();
				}
				else
				{
					if(this._recvReq.status == 404 && this.state == Session.STATE.DISCONNECTING)
					{
						info("Failed to recv during shutdown -- that's fine");

						this.state = Session.STATE.DISCONNECTED;
						this._sessionId = null;
						this.onstatechange(this, this.state);
					}
					else
					{
						var errorText = "Connection closed, HTTP response: " + this._recvReq.status;
						var error = Session.ERROR.RECV_FAILED;
						warn(errorText);
						this.onerror(this, error, errorText);

						if(this._recvReq.status == 404)
						{
							this._sessionId = null;
						}
						else if(this._sessionId && !this._recvTimeout)
						{
							debug("Reconnecting to stream");
							//this._recvTimeout = window.setTimeout(bind(this, this.performRecv), 1000);
						}																							
					}
				}
			}
		},

		handleRecvLoad: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			this.checkProgress();

			if(this._lastPacket != PACKET.RECONN &&
				this._lastPacket != PACKET.DELETED &&
				!this._longPoll)
			{
				this.error = Session.ERROR.RECV_FAILED;
				this.errorText = "HTTP stream closed, last packet was " + enumToStr(PACKET, this._lastPacket);
				warn(this.errorText);
				this.onerror(this, error, this.errorText);
			}

			if(this._sessionId && !this._recvTimeout)
			{
				info("Reconnecting to stream");
				this._recvTimeout = window.setTimeout(bind(this, this.performRecv), 50);	
			}
		},

		performRecv: function()
		{
			assert(this instanceof Session, "this instanceof Session");

			assert(this._recvTimeout, "this._recvTimeout");
			window.clearTimeout(this._recvTimeout);
			this._recvTimeout = null;

			debug("performRecv");

			var uri = this._sessionUri + "?act=recv&sid=" + this._sessionId;

			if(this._longPoll)
			{
				uri += "&long_poll=1";
			}

			if(this._recvReq)
			{
				clearRequest(this._recvReq);
				this._recvReq = null;
			}

			this._recvIdx = 0;

			if(typeof XDomainRequest == 'undefined')
			{
				this._recvReq = this.makeXHR("GET", uri, true);
				this._recvReq.onreadystatechange = bind(this, this.handleRecvStateChange);
				this._recvReq.send(null);

				assert(this._recvReq.readyState == XHR.LOADING, "this._recvReq.readyState == XHR.LOADING");

				if(this._localPoll)
				{
					this._checkTimeout = window.setTimeout(bind(this, this.checkProgress), 100); 
				}
			}
			else
			{
				this._recvReq = new XDomainRequest;
				this._recvReq.onprogress = bind(this, this.checkProgress);
				this._recvReq.onload = bind(this, this.handleRecvLoad);

				assert(isXDR(this._recvReq), "isXDR(this._recvReq)");

				uri += (uri.match(/\?/) ? "&" : "?") + "ts=" + (new Date()).getTime();

				this._recvReq.open("GET", uri, true);
				this._recvReq.send(null);
			}
		},

		handlePostStateChange: function(req)
		{
			assert(this instanceof Session, "this instanceof Session");

			debug("handlePostStateChange, req.readyState=" + req.readyState);

			var oldState = this.state;

			if(req.readyState == XHR.COMPLETED)
			{
				var item = this._actionQueue.shift();

				assert(item.req == req, "item.req == req");
				assert(req == this._currentPost, "req == this._currentPost");

				var status = req.status;
				var responseText = req.responseText;

				clearRequest(req);

				this._currentPost = null;
				req = null;


				if(status != 200)
				{
					var errorText = "Request failed for URI " + item.uri + " failed: " + status;
					this.onerror(this, item.error, errorText);

					if(item.error == Session.ERROR_INITIALIZE_FAILED)
					{
						this.state = Session.STATE.DISCONNECTED;
					}
					if(item.error == Session.ERROR.CONNECT_FAILED)
					{
						this.state = Session.STATE.DISCONNECTED;
					}
					else if(item.error == Session.ERROR.DISCONNECT_FAILED)
					{
						this.state = Session.STATE.CONNECTED;
					}
					else if(item.error == Session.ERROR.SHUTDOWN_FAILED)
					{
						this.state = Session.STATE.CONNECTED;					
					}

				}
				else
				{
					debug("Successfully loaded URI " + item.uri + " with body " + item.body);

					if(item.error == Session.ERROR.INITIALIZATION_FAILED)
					{
						debug("Going to state CONNECTED");

						this._sessionId = responseText.replace(/^\s+|\s+$/g,"");
						this.state = Session.STATE.CONNECTED;

						assert(!this._recvTimeout, "!this._recvTimeout");

						this._recvTimeout = window.setTimeout(bind(this, this.performRecv), 1);
					}
				}

				if(this._actionQueue.length > 0)
				{
					var next = this._actionQueue[0];

					assert(next.req.readyState > XHR.DISCONNECTED, "next.req.readyState > XHR.DISCONNECTED");

					try
					{
						debug("Front state is " + next.req.readyState + " LOADING would be " + XHR.LOADING);

						if(!next.sent && next.req.readyState < XHR.LOADED)
						{
							debug("Sending XHR for URI " + next.uri);

							this._currentPost = next.req;
							next.req.send(next.body);
							next.sent = true;
						}
					}
					catch(e)
					{
						throw new Error("Failed to request URI " + next.uri + " with body " + next.body + ": " + e.message);
					}
				}
			}

			debug("-- handlePostStateChange");

			console.assert(typeof this.state !== "undefined");
			console.assert(typeof oldState !== "undefined");

			if(this.state != oldState)
			{
				this.onstatechange(this, this.state);
			}
		},

		enqueuePostAction: function(uri, body, error)
		{
			assert(this instanceof Session, "this instanceof Session");

			debug("enqueuePostAction() called -- " + uri);

			var req = this.makeXHR("POST", uri, true);

			if(!body)
			{
				body = "";
			}

			this._actionQueue.push({
					uri: uri,
					req: req, 
					body: body, 
					error: error,
					sent: false
				});

			req.onreadystatechange = bind(this, this.handlePostStateChange, req);

			if(this._actionQueue.length == 1)
			{
				var item = this._actionQueue[0];

				assert(req.readyState > XHR.DISCONNECTED, "req.readyState > XHR.DISCONNECTED");

				debug("Sending enqueued request with state " + req.readyState);
				this._currentPost = req;
				req.send(body);
				debug("sent");
				item.sent = true;
			}
		},

		create: function()
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(!this._sessionId, "_sessionId is not null");
			
			var uri = this._sessionUri + 
				"?act=create";

			this.enqueuePostAction(uri, null, Session.ERROR.INITIALIZATION_FAILED);
			this.state = Session.STATE.CONNECTING;
		},

		enqConnect: function(cid, host, port)
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(cid, "cid is null");
			assert(host, "host is null");
			assert(port, "port is null");
			assert(this._sessionId, "Can't connect without stream id");

			var uri = this._sessionUri +
				"?act=connect" + 
				"&sid=" + this._sessionId + 
				"&cid=" + cid.toString(16) +
				"&host=" + host + 
				"&port=" + port;

			this.enqueuePostAction(uri, null, Session.ERROR.CONNECT_FAILED);
		},

		enqDisconnect: function(conn)
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(this._sessionId, "_sessionId not null");
			assert(conn, "conn not null");
			var cid = conn.getId();
			assert(cid, "cid not null");

			var uri = this._sessionUri + 
				"?act=disconnect" +
				"&sid=" + this._sessionId +
				"&cid=" + cid.toString(16);

			this.enqueuePostAction(uri, null, Session.ERROR.DISCONNECT_FAILED);
		},

		enqSend: function(conn, data)
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(this._sessionId, "_sessionId is not null");
			assert(conn, "conn not null");
			var cid = conn.getId();
			assert(cid, "cid not null");

			debug("Sending '" + window.escape(data) + "' to connection");

			var uri = this._sessionUri + 
				"?act=send" +
				"&sid=" + this._sessionId +
				"&cid=" + cid.toString(16);

			this.enqueuePostAction(uri, data, Session.ERROR.SEND_FAILED);
		},
		
		enqShutdown: function(data)
		{
			assert(this instanceof Session, "this instanceof Session");
			assert(this._sessionId, "_sessionId is null");
			var uri = this._sessionUri + "?act=delete&sid=" + this._sessionId;
			this.enqueuePostAction(uri, null, Session.ERROR.SHUTDOWN_FAILED);
			this.state = Session.STATE.DISCONNECTING;
		}

	};

}();

this.Connection = Connection;
this.Session = Session;

};

HADES._construct();

