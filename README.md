hades
=====

A fast proxy allowing javascript code to open arbitrary TCP connections via XHR

I wrote this a couple of years ago (when there was no websockets) - a single daemon allows client-side (JS) code to directly connect through TCP.

So no messages and no processing on the server side - the client is only notified about a new chunk of bytes arriving on the connection or state changes.

As an example I included a script which connects to time.nist.gov:13 and fetches
 the current time.

## Prerequisites

libevent 2.0.19 (this is the one in debian 7 right now) - I pushed some changes upstream which they eventually integrated... I was quite surprised to notice that my code suddenly works without a patched libevent 4 years later. :-)

Unfortunately it does not work with the latest libevent stable version - this needs to be fixed of cours.

## Usage

To test:

    make 
    ./hades

... and open http://127.0.0.1:8080/daytime.html in your browser
