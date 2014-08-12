#ifdef WIN32
#include <compat/sys/queue.h>
#endif

#include <stddef.h>

#include <getopt.h>
#include <signal.h>

#include <stdbool.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <assert.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <inttypes.h>

#include <errno.h>
#include <sys/queue.h>
#include <sys/socket.h>

#include <event.h>
#include <evutil.h>
#include <evhttp.h>
#include <evdns.h>

#include "tree.h"

#ifdef WIN32
#pragma comment(lib, "libevent-2.0.5-beta/libevent.lib")
#pragma comment(lib, "ws2_32.lib")
#endif

uint16_t port = 8080;

typedef enum 
{
	ACTION_UNKNOWN = 0,
	ACTION_CREATE = 1,
	ACTION_DELETE = 2,
	ACTION_CONNECT = 3,
	ACTION_DISCONNECT = 4,
	ACTION_SEND = 5,
	ACTION_RECV = 6
} action_type;

struct session;

struct connection {

	struct bufferevent *bev;
	struct session *sess;

	TREE_ENTRY(connection) linkage;

	int id;
};

static int connection_compare(struct connection *lhs, struct connection *rhs)
{
	return (lhs->id < rhs->id) ? -1 : ((lhs->id > rhs->id) ? 1 : 0);
}

typedef TREE_HEAD(connection_tree, connection) connection_tree;

TREE_DEFINE(connection, linkage);

struct session {

	struct proxy *prx;
	struct evbuffer *evb;

	unsigned sent_chunks;

	connection_tree conns;

	/**
	 * Currently sessioning request if any, NULL otherwise.
	 */
	struct evhttp_request *req;

	bool long_poll;

	TREE_ENTRY(session) linkage;
};

static int session_compare(struct session *lhs, struct session *rhs)
{
	return (lhs < rhs) ? -1 : ((lhs > rhs) ? 1 : 0);
}

typedef TREE_HEAD(session_tree, session) session_tree;

TREE_DEFINE(session, linkage);

struct proxy {
	session_tree sessions;
	struct event_base *base;
	struct evhttp *http;
	struct evdns_base *dns;
};

static const char *dump_what(short what)
{
	static char buffer[256];

	char *p = buffer;
	*p = 0;
	if(what & BEV_EVENT_READING)
		p += sprintf(p,"READ ");
	if(what & BEV_EVENT_WRITING)
		p += sprintf(p,"WRITE ");
	if(what & BEV_EVENT_EOF)
		p += sprintf(p,"EOF ");
	if(what & BEV_EVENT_ERROR)
		p += sprintf(p,"ERROR ");
	if(what & BEV_EVENT_TIMEOUT)
		p += sprintf(p,"TIMEOUT ");
	if(what & BEV_EVENT_EOF)
		p += sprintf(p,"EOF ");
	if(what & BEV_EVENT_CONNECTED)
		p += sprintf(p,"CONNECTED ");
	return buffer;
}

typedef enum {
	PKT_CONNFAIL,
	PKT_CONNECTED,
	PKT_DISCONNECTED,
	PKT_DATA,
	PKT_PAD,
	PKT_TAKEOVER,
	PKT_RECONN,
	PKT_DELETED
} session_pkt_type;

struct prefix {
	char magic[5];
	char type[2];
	char cid[16];
	char payload_length[8];
};

static void make_prefix(struct prefix *pfx, uint8_t type, uint64_t cid, uint32_t payload_length)
{
	memcpy(pfx->magic, "MAGIC", 5);
	sprintf(pfx->type, "%02x", type);
	sprintf(pfx->cid, "%016" PRIx64, cid);
	sprintf(pfx->payload_length, "%08x", payload_length);
}

static void send_some_pad(struct evhttp_request *req, size_t sz)
{
	struct evbuffer *evb = evbuffer_new();
        struct prefix pfx;
        char *pad;
	pad = malloc(sz);
	memset(pad, '?', sz);
        make_prefix(&pfx, PKT_PAD, 0, sz);
        evbuffer_add(evb, &pfx, sizeof(pfx));
        evbuffer_add(evb, pad, sz);
        evhttp_send_reply_chunk(req, evb);
        evbuffer_free(evb);
	free(pad);
}

static void ask_recon(struct session *sess, struct connection *conn)
{
	struct prefix pfx;
	make_prefix(&pfx, PKT_RECONN, conn->id, 0);
	evbuffer_add(sess->evb, &pfx, sizeof(pfx));
	evhttp_send_reply_chunk(sess->req, sess->evb);
	sess->sent_chunks = 0;
	evhttp_send_reply_end(sess->req);
	sess->req = NULL;
}

static void handle_bev_read(struct bufferevent *bev, void *udata)
{
	struct connection *conn = udata;
	struct session *sess = conn->sess;
	struct prefix pfx;
	struct evbuffer *evb;
	
	printf("handle_bev_read() -- evbuffer_get_length(evb)=%zd\n", evbuffer_get_length(bufferevent_get_input(bev)));

	evb = evbuffer_new();
	bufferevent_read_buffer(bev, evb);
	make_prefix(&pfx, PKT_DATA, conn->id, evbuffer_get_length(evb));
	evbuffer_prepend(evb, &pfx, sizeof(pfx));
	evbuffer_add_buffer(sess->evb, evb);
	evbuffer_free(evb);

	if(sess->req)
	{
		evhttp_send_reply_chunk(sess->req, sess->evb);
		send_some_pad(sess->req, 16);

		if(sess->long_poll || ++sess->sent_chunks > 2)
		{
			ask_recon(sess, conn);
		}
	}
}

static void handle_bev_write(struct bufferevent *bev, void *udata)
{
	printf("handle_bev_write()\n"); 
}

static void handle_bev_event(struct bufferevent *bev, short what, void *udata)
{
	struct connection *conn = udata;
	struct session *sess = conn->sess;

	if(sess == NULL)
	{
		fprintf(stderr, "Internal error - sess of conn %p is NULL", conn);
		abort();
	}

	if(conn == NULL)
	{
		fprintf(stderr, "Internal error - conn is NULL");
		abort();
	}

	printf("handle_bev_event()\n");

	if(what & BEV_EVENT_CONNECTED)
	{
		struct prefix pfx;

		printf("CONNECTED\n"); 

		if(sess->evb == NULL)
		{
			fprintf(stderr, "Internal error - evb of sess %p is NULL", sess);
			abort();
		}

		make_prefix(&pfx, PKT_CONNECTED, conn->id, 0);
	        evbuffer_add(sess->evb, &pfx, sizeof(pfx));

		if(sess->req)
		{
			evhttp_send_reply_chunk(sess->req, sess->evb);
			send_some_pad(sess->req, 16); //2096 * 4);
			
			if(sess->long_poll) ask_recon(sess, conn);			
		}

		conn->bev = bev;

		bufferevent_enable(bev, EV_READ|EV_WRITE);
	}
	else if(what & BEV_EVENT_EOF)
	{
		struct prefix pfx;

		printf("EOF -- sending PKT_DISCONNECTED\n");

		bufferevent_free(conn->bev);
		conn->bev = NULL;

		make_prefix(&pfx, PKT_DISCONNECTED, conn->id, 0);
        	evbuffer_add(sess->evb, &pfx, sizeof(pfx));

		if(sess->req)
		{
		        evhttp_send_reply_chunk(sess->req, sess->evb);
			send_some_pad(sess->req, 16);

			if(sess->long_poll) ask_recon(sess, conn);			
//			evhttp_send_reply_end(sess->req);
			/* evhttp_request_free(sess->req); */
//			sess->req = NULL;
		}
	}
	else if(what & BEV_EVENT_ERROR)
	{
		struct prefix pfx;
		
		int dns_error = bufferevent_socket_get_dns_error(bev);

		if(dns_error)
		{
			fprintf(stderr, "ERROR (dns error)\n");
		}
		else
		{
			fprintf(stderr, "ERROR (failed to connect)\n");
		}

		bufferevent_free(conn->bev);
		conn->bev = NULL;

		make_prefix(&pfx, PKT_CONNFAIL, conn->id, 0);
		evbuffer_add(sess->evb, &pfx, sizeof(pfx));
		
		if(sess->req)
		{
			evhttp_send_reply_chunk(sess->req, sess->evb);
			evhttp_send_reply_end(sess->req);
			sess->req = NULL;	
		}
	}
	else
	{
		fprintf(stderr, "WARN: Unknown event: %s", dump_what(what));
	}
}

static void disable_caching(struct evhttp_request *req)
{
	evhttp_add_header(req->output_headers, "Cache-Control", "no-store,no-cache,must-revalidate");
	evhttp_add_header(req->output_headers, "Pragma", "no-cache");
	evhttp_add_header(req->output_headers, "Expires", "-1");

	evhttp_add_header(req->output_headers, "Access-Control-Allow-Origin", "*");
	evhttp_add_header(req->output_headers, "Access-Control-Allow-Methods", "GET, POST");
	evhttp_add_header(req->output_headers, "Access-Control-Allow-Headers", "cache-control,expires,pragma,content-type");

}

static void session_create(struct evhttp_request *req, struct proxy *prx)
{
	struct session *sess;
	struct evbuffer *buf;

	sess = calloc(1, sizeof(struct session));
	if(sess == NULL)
	{
		evhttp_send_error(req, 500, "Session allocation failed");
		return;
	}
	
	TREE_INIT(&sess->conns, connection_compare);

	sess->long_poll = false;
	sess->sent_chunks = 0;
	sess->prx = prx;

	sess->evb = evbuffer_new();
	if(sess->evb == NULL)
	{
		evhttp_send_error(req, 500, "Buffer allocation failed");
		free(sess);
		return;
	}

	buf = evbuffer_new();
	if(buf == NULL)
	{
		evhttp_send_error(req, 500, "Buffer allocation failed");
		evbuffer_free(sess->evb);
		free(sess);
		return;
	}

	if(evhttp_add_header(req->output_headers, "Content-type", "text/plain; charset=utf-8") == 0)
	{
		if(evbuffer_add_printf(buf, "%"PRIxPTR"\r\n", (uintptr_t)sess) > 0)
		{
			TREE_INSERT(&prx->sessions, session, linkage, sess);

			evhttp_send_reply(req, 200, NULL, buf);
			evbuffer_free(buf);

			printf("session_create(...) => %"PRIxPTR"\n", (uintptr_t)sess); 

			return;
		}
	}

	evhttp_send_error(req, 500, "Failed to construct reply");
	evbuffer_free(buf);
	evbuffer_free(sess->evb);
	free(sess);
}

static void connection_free(struct connection *conn, void *udata)
{
	if(conn->bev)
	{
		bufferevent_free(conn->bev);
		conn->bev = NULL;
	}

	conn->sess = NULL;

	free(conn);
}

static void session_free(struct session *sess, void *udata)
{
	printf("session_delete(0x%"PRIxPTR")\n", (uintptr_t)sess);
	
	while(sess->conns.th_root != NULL)
	{
		struct connection *conn = sess->conns.th_root;
		TREE_REMOVE(&sess->conns, connection, linkage, sess->conns.th_root);
		connection_free(conn, NULL);
	}

	if(sess->evb)
	{
		evbuffer_free(sess->evb);
		sess->evb = NULL;
	}

	if(sess->req)
	{
		evhttp_send_reply_end(sess->req);
		sess->req = NULL;
	}

	TREE_REMOVE(&sess->prx->sessions, session, linkage, sess);
	free(sess);
}

static void session_delete(struct evhttp_request *req, struct session *sess)
{
	printf("session_delete(..., 0x%"PRIxPTR")\n", (uintptr_t)sess);

	if(sess->req)
	{
		struct prefix pfx;
        	make_prefix(&pfx, PKT_DELETED, 0, 0);
		evbuffer_add(sess->evb, &pfx, sizeof(pfx));

		evhttp_send_reply_chunk(sess->req, sess->evb); 
		evhttp_send_reply_end(sess->req);
		sess->req = NULL;
	}

	session_free(sess, NULL);

	evhttp_send_reply(req, 200, NULL, NULL);
}

static int safe_strtoul(const char *str, unsigned base, uintptr_t *out)
{
	char *endp;
	errno = 0;
	*out = strtoull(str, &endp, base);
	return (errno == 0 && *endp == 0 && endp != str);
}

static void session_connect(struct evhttp_request *req, struct evkeyvalq *params, struct session *sess)
{
	struct bufferevent *bev;
	const char *host;
	const char *port_str;
	const char *cid_str;
	uintptr_t port;
	uintptr_t cid;
	struct connection *conn;
	int ret;
	struct evbuffer *buf;
	printf("session_connect(..., sess=0x%"PRIxPTR")\n", (uintptr_t)sess); 

	host = evhttp_find_header(params, "host");
        if (host == NULL) {
                evhttp_send_error(req, 400, "No host specified");
                return;
        }

        port_str = evhttp_find_header(params, "port");
        if(port_str == NULL) {
                evhttp_send_error(req, 400, "No port specified");
                return;
        }

	if(!safe_strtoul(port_str, 10, &port) || port < 1 || port > 0xffff) {
                evhttp_send_error(req, 400, "Invalid port specified");
                return;
        }

        cid_str = evhttp_find_header(params, "cid");
        if(cid_str == NULL) {
                evhttp_send_error(req, 400, "No cid specified");
                return;
	}

	if(!safe_strtoul(cid_str, 16, &cid) || cid < 1 || cid > 0xffffffffULL) {
                evhttp_send_error(req, 400, "Invalid cid specified");
                return;
        }

	printf("created connection 0x%"PRIxPTR"\n", cid); 

	buf = evbuffer_new();
	if(buf == NULL)
	{
		evhttp_send_error(req, 500, "Buffer allocation failed");
		evbuffer_free(sess->evb);
		free(sess);
		return;
	}

        bev = bufferevent_socket_new(sess->prx->base, -1, BEV_OPT_CLOSE_ON_FREE);
        if (bev == NULL) {
                evhttp_send_error(req, 500, "bufferevent_socket_new() failed");
                return;
        }

	conn = calloc(1, sizeof(struct connection));
	if(conn == NULL)
	{
		evhttp_send_error(req, 500, "Connection allocation failed");
		return;
	}
	conn->id = cid;
	conn->sess = sess;
	conn->bev = bev;

	bufferevent_setcb(bev, handle_bev_read, handle_bev_write, handle_bev_event, conn);

	printf("session_connect(..., 0x%"PRIxPTR") -- connecting to %s:%ld\n", (uintptr_t)sess, host, port); 

	ret = bufferevent_socket_connect_hostname(bev, sess->prx->dns, AF_UNSPEC, host, port);
	if (ret < 0) {
		evhttp_send_error(req, 500, "bufferevent_socket_connect_hostname() failed");
		connection_free(conn, NULL);
		conn = NULL;
		return;
	}

	if(evhttp_add_header(req->output_headers, "Content-type", "text/plain; charset=utf-8") == 0)
	{
		if(evbuffer_add_printf(buf, "%"PRIxPTR"\r\n", (uintptr_t)conn) > 0)
		{
			TREE_INSERT(&sess->conns, connection, linkage, conn);

			evhttp_send_reply(req, 200, NULL, buf);
			evbuffer_free(buf);

			printf("session_connect(...) => %"PRIxPTR"\n", (uintptr_t)conn); 

			return;
		}
	}


	evhttp_send_reply(req, 200, NULL, NULL);
}

static void session_disconnect(struct evhttp_request *req, struct session *sess, struct connection *conn)
{
	printf("connection_disconnect(..., 0x%"PRIxPTR")\n", (uintptr_t)conn);

	bufferevent_free(conn->bev);
	conn->bev = NULL;	

        evhttp_send_reply(req, 200, NULL, NULL);
}

static void session_send(struct evhttp_request *req, struct connection *conn)
{
	printf("connection_send(..., 0x%"PRIxPTR") -- %zd bytes\n", (uintptr_t)conn, evbuffer_get_length(req->input_buffer));

	if(conn->bev == NULL)
	{
		evhttp_send_error(req, 400, "Connection not connected");
		return;
	}

	if(bufferevent_write_buffer(conn->bev, req->input_buffer) < 0)
	{
		evhttp_send_error(req, 500, "Writing to buffer failed");
		return;
	}

	evhttp_send_reply(req, 200, NULL, NULL);
}

static void handle_recv_close(struct evhttp_connection *con, void *udata)
{
	struct session *sess = udata;
	printf("handle_recv_close(..., 0x%"PRIxPTR")\n", (uintptr_t)sess); 
}

static void session_recv(struct evhttp_request *req, struct session *sess, struct evkeyvalq *params)
{
	const char *long_poll_str;

	printf("session_recv(..., 0x%"PRIxPTR")\n", (uintptr_t)sess); 

	if(sess->req)
	{
		struct prefix pfx;
	        make_prefix(&pfx, PKT_TAKEOVER, 0, 0);
		evbuffer_add(sess->evb, &pfx, sizeof(pfx));
		evhttp_send_reply_chunk(sess->req, sess->evb);
		evhttp_send_reply_end(sess->req);
		evhttp_add_header(req->output_headers, "X-Session-Takeover", "true");
	}

	evhttp_connection_set_closecb(req->evcon, handle_recv_close, sess);

	//evhttp_request_own(req);
	sess->req = req;

	long_poll_str = evhttp_find_header(params, "long_poll");
	sess->long_poll = long_poll_str ? (atoi(long_poll_str) != 0) : false;

	evhttp_add_header(req->output_headers, "Content-Type", "x-application/something-unknown");

	evhttp_send_reply_start(req, 200, NULL);

	send_some_pad(req, 16); //2048);

	if(evbuffer_get_length(sess->evb))
	{
		evhttp_send_reply_chunk(sess->req, sess->evb);
		send_some_pad(req, 16);

		if(sess->long_poll)
		{
                	evhttp_send_reply_end(sess->req);
			sess->req = NULL;			
		}
	}
}

static action_type parse_action(const char *action)
{
	if(!strcmp(action, "create"))
		return ACTION_CREATE;
	if(!strcmp(action, "delete"))
		return ACTION_DELETE;
	if(!strcmp(action, "connect"))
		return ACTION_CONNECT;
	if(!strcmp(action, "disconnect"))
		return ACTION_DISCONNECT;
	if(!strcmp(action, "recv"))
		return ACTION_RECV;
	if(!strcmp(action, "send"))
		return ACTION_SEND;
	return ACTION_UNKNOWN;
}

static void handle_connection_action(action_type action, struct evhttp_request *req, struct evkeyvalq *params, struct session *sess)
{
	const char *cid_str = NULL;
	uintptr_t cid;
	struct connection *conn = NULL;
	struct connection dummy;

	cid_str = evhttp_find_header(params, "cid");
	if(!safe_strtoul(cid_str, 16, (uintptr_t *)&cid))
	{
		evhttp_send_error(req, 400, "Invalid connection specified");
		return;
	}

	dummy.id = cid;

	conn = TREE_FIND(&sess->conns, connection, linkage, &dummy);
	if(conn == NULL)
	{
		evhttp_send_error(req, 404, "Connection not found");
		return;
	};

	if(action == ACTION_DISCONNECT)
	{
		session_disconnect(req, sess, conn);
	}
	else if(action == ACTION_SEND)
	{
		session_send(req, conn);
	}
	else
	{
		evhttp_send_error(req, 400, "Invalid action");
	}
}

static void handle_session(struct evhttp_request *req, void *udata)
{
	struct proxy *prx = udata;
	struct evkeyvalq params;
        const char *session_str;
	uintptr_t session_id;
	struct session *sess;
	const char *action_str;
	action_type action;
	char *endp;

	disable_caching(req);

	if(req->type == EVHTTP_REQ_OPTIONS)
	{
		evhttp_send_reply(req, 200, NULL, NULL);
		return;
	}

        TAILQ_INIT(&params);

        evhttp_parse_query(req->uri, &params);

	action_str = evhttp_find_header(&params, "act");
	if(action_str == NULL)
	{
		evhttp_send_error(req, 400, "No action specified");
		goto cleanup;
	}

	action = parse_action(action_str);
	if(action == ACTION_UNKNOWN)
	{
		evhttp_send_error(req, 400, "Invalid action specified");
		goto cleanup;
	}

	if(action == ACTION_CREATE)
	{
		session_create(req, prx);
		goto cleanup;
	}

	session_str = evhttp_find_header(&params, "sid");
        if (session_str == NULL) {
       	        evhttp_send_error(req, 400, "No session specified");
		goto cleanup;
        }

        errno = 0;
       	session_id = strtoull(session_str, &endp, 16);
        if (errno != 0 || *endp != 0 || endp == session_str) {
       	        evhttp_send_error(req, 400, "Invalid session specified");
               	goto cleanup;
        }

	sess = TREE_FIND(&prx->sessions, session, linkage, (struct session *)session_id);
	if(sess == NULL)
	{
		evhttp_send_error(req, 404, "Session not found");
		goto cleanup;
	}

	switch(action)
	{
	case ACTION_CONNECT:
		session_connect(req, &params, sess);
		break;
	case ACTION_DELETE:
		session_delete(req, sess);
		break;
	case ACTION_RECV:
		session_recv(req, sess, &params);
		break;
	case ACTION_DISCONNECT:
	case ACTION_SEND:
		handle_connection_action(action, req, &params, sess);
		break;
	case ACTION_UNKNOWN:
	case ACTION_CREATE:
	default:
		abort();
	}

cleanup:
        evhttp_clear_headers(&params);
}

static void handle_shutdown(struct evhttp_request *req, void *udata)
{
	struct proxy *prx = udata;
	
	disable_caching(req);

	if(req->type == EVHTTP_REQ_OPTIONS)
	{
		evhttp_send_reply(req, 200, NULL, NULL);
		return;
	}

	event_base_loopbreak(prx->base);
}

static void handle_gen(struct evhttp_request *req, void *udata)
{
	const char *fn;
	struct stat st;
	int rc, fd;
	struct evbuffer *evb;

	disable_caching(req);

	if(req->type == EVHTTP_REQ_OPTIONS)
	{
		evhttp_send_reply(req, 200, NULL, NULL);
		return;
	}

	if(req->uri[0] != '/' || strrchr(req->uri, '/') != req->uri)
	{
		evhttp_send_error(req, 400, "Bad URI");		
	}

	fn = req->uri + 1;

	fd = open(fn, O_RDONLY);
	if(fd < 0)
	{
		evhttp_send_error(req, 400, "open() failed");
		return;
	}

	rc = fstat(fd, &st);
	if(rc < 0)
	{
		close(fd);
		evhttp_send_error(req, 400, "stat() failed");
		return;
	}

	evb = evbuffer_new();

	rc = evbuffer_add_file(evb, fd, 0, st.st_size);
	if(rc < 0)
	{ 
		close(fd);
		evhttp_send_error(req, 400, "evbuffer_add_file() failed");
		return;
	}

	if(strstr(req->uri, ".js"))
	{
		evhttp_add_header(req->output_headers, "Content-Type", "text/javascript");
	}

	evhttp_send_reply(req, 200, NULL, evb);

	evbuffer_free(evb);
}

static void show_usage(void)
{
	fprintf(stderr, 
		"Usage: hades [OPTION]...\n"
		"Available options:\n"
		" -p PORT	Binds to the given port\n"
		" -h 		Prints this information\n");
}

static void handle_argv(int argc, char **argv)
{
	int c, err = 0;
	unsigned long given_port;

	while ((c = getopt(argc, argv, "hp:")) != -1) 
	{
		switch(c) 
		{
		case 'p':
			if(!safe_strtoul(optarg, 10, &given_port) || given_port > 0xffff)
			{
				fprintf(stderr, "Error: Invalid port: %s\n", optarg);
				err += 1;
			}
			else
			{
				port = given_port;
			}
			break;

		case ':':
			fprintf(stderr, "Error: Option -%c requires an operand\n", optopt);
			err += 1;
			break;

		case 'h':
			show_usage();
			exit(EXIT_SUCCESS);
			break;
		
		case '?':
			fprintf(stderr, "Error: Unrecognized option: -%c", optopt);
			err += 1;
			break;
		}
	}
	
	if(err)
	{
		show_usage();
		exit(EXIT_FAILURE);
	}		
}

int main(int argc, char **argv)
{
	struct proxy prx = { TREE_INITIALIZER(session_compare), NULL, NULL, NULL };
	int ret;

	setvbuf(stdout, NULL, _IONBF, 0);
	setvbuf(stderr, NULL, _IONBF, 0);

	if(signal(SIGPIPE, SIG_IGN) == SIG_ERR)
	{
		perror("signal(SIGPIPE, SIG_IGN) failed");
		return EXIT_FAILURE;
	}

	handle_argv(argc, argv);

	prx.base = event_base_new();
	prx.http = evhttp_new(prx.base);
	prx.dns = evdns_base_new(prx.base, 1);
	ret = evhttp_bind_socket(prx.http, "0.0.0.0", port);
	if(ret < 0)
	{
		fprintf(stderr, "Binding to port %"PRIu16" failed\n", port);
		return EXIT_FAILURE;
	}
	
	evhttp_set_allowed_methods(prx.http, EVHTTP_REQ_GET | EVHTTP_REQ_POST | EVHTTP_REQ_OPTIONS);
	evhttp_set_gencb(prx.http, handle_gen, &prx);
	evhttp_set_cb(prx.http, "/session", handle_session, &prx);
	evhttp_set_cb(prx.http, "/shutdown", handle_shutdown, &prx);

	fprintf(stderr, "Starting dispatch, listing on port %"PRIu16"\n", port);
	event_base_dispatch(prx.base);

	while(prx.sessions.th_root != NULL)
		session_free(prx.sessions.th_root, NULL);

	fprintf(stderr, "Shutdown complete, freeing event base\n");
	
	evdns_base_free(prx.dns, 1);
	evhttp_free(prx.http);
	event_base_free(prx.base);
	
	return EXIT_SUCCESS;
}
