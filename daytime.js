/*jsl:option explicit*/
/*jsl:import tcpstream.js*/

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
			console.fatal(e);
		}
	};
}

function enumToStr(en, value)
{
	for (var str in en) {
		if (en[str] == value) {
			return str;
		}
	}

	return value;
}

function printLine(str, color)
{
	var d = document.createElement("div");
	var p = document.createElement("span");
	p.style.color = color;
	p.style.fontSize = '8pt';
	p.style.fontFamily = 'monospace';
	var t = document.createTextNode(str.replace(/^\s+|\s+$/g,""));
	p.appendChild(t);
	d.appendChild(p);
	document.body.appendChild(d);
	console.info(str);
}

function /* class */ TestConnection(connection) {
	console.assert(connection instanceof HADES.Connection, "instanceof Connection");

	this._connection = connection;
	this._buffer = "";
	this._connection.onrecv = bind(this, this.recv);
	this._connection.onstatechange = bind(this, this.stateChange);
}

TestConnection.prototype = function() {

	return {

		constructor: TestConnection,

		send: function(data)
		{
			printLine(">>> " + data, "green");
			this._connection.send(data);
		},

		recv: function(conn, data)
		{
		        printLine("<<< " + data, "blue");
		},

		stateChange: function(conn, state) {
			printLine("--- CONNECTION STATE: " + enumToStr(window.HADES.Connection.STATE, state), 'gray');

			if(state === window.HADES.Connection.STATE.DISCONNECTED)
			{
				this._connection.getSession().shutdown();
			}
		}
	};
}();

function /* class */ TestMgr(session, host, port) {
	this._session = session;
	this._host = host;
	this._port = port;
	this._buffer = "";
}

TestMgr.prototype = function() {
	return {
		constructor: TestMgr,

		statechanged: function(session, state)
		{
			printLine("--- SESSION STATE CHANGED: " + enumToStr(HADES.Session.STATE, state), "black");

			if(state === HADES.Session.STATE.CONNECTED)
			{
				this._connection = new TestConnection(session.connect(this._host, this._port));
			}
		}
	};
}();

function runTest()
{
	var session = new this.HADES.Session(null, location.port);
	var tmgr = new TestMgr(session, "time.nist.gov", 13);
	session.onstatechange = bind(tmgr, tmgr.statechanged);
	session.init();
}

window.setTimeout(function() {
	runTest();
}, 10);
