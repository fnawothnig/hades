hades
=====

A fast proxy allowing javascript code to open arbitrary TCP connections via XHR

I wrote this a couple of years ago (when there was no websockets) - a single daemon allows client-side (JS) code to directly connect through TCP.

So no messages and no processing on the server side - the client is only notified about a new chunk of bytes arriving on the connection or state changes.

As an example I included a script which connects to time.nist.gov:13 and fetches
 the current time.

## Prerequisites

libevent 2.0.19 (this is the one in debian 7 right now) - I pushed some changes upstream which they eventually integrated... I was quite surprised to notice that my code suddenly works without a patched libevent 4 years later. :-)

Unfortunately it does not work with the latest libevent stable version - this needs to be fixed of course.

## Usage

To test:

    make 
    ./hades

... and open http://127.0.0.1:8080/daytime.html in your browser

## TODO

Obviously there is lots of stuff to be done.

1. Add websockets support
2. Support the newer libevent interface
3. Testing on a variety of browsers
4. Possibly adding other methods of getting the data through
5. UDP support
6. Windows support (it already worked in the past)
7. Make the HADES.* JS classes more sexy.
8. Write some cool web app which uses it. ;-)

## Contributing

1. Fork it
2. Create your feature branch (git checkout -b my-new-feature)
3. Commit your changes (git commit -am 'Add some feature')
4. Push to the branch (git push origin my-new-feature)
5. Create a new Pull Request

Or simply write a patch and send me an E-Mail. :-)
