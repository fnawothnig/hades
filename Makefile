CFLAGS += -g -O0 -std=c99
CFLAGS += -Wall -Werror -Wall -fno-strict-aliasing -W -Wfloat-equal -Wundef -Wpointer-arith -Wwrite-strings -Wredundant-decls -Wchar-subscripts -Wcomment -Wformat -Wwrite-strings -Wredundant-decls -Wbad-function-cast -Wswitch-enum -Werror -Wno-unused-parameter -Wno-sign-compare -Wstrict-aliasing -Winit-self -Wmissing-field-initializers -Wdeclaration-after-statement -Waddress -Wnormalized=id -Woverride-init 

LDLIBS += -levent

all: hades

jsl:
	jsl -conf jsl.conf

hades: hades.o
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $^ $(LDLIBS)

clean:
	$(RM) hades hades.o
