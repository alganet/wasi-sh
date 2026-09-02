#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H
#ifndef __ASSEMBLER__

#ifndef SOCK_RAW
#define SOCK_RAW 3
#endif
#ifndef SOCK_SEQPACKET
#define SOCK_SEQPACKET 5
#endif
#ifndef SOCK_RDM
#define SOCK_RDM 4
#endif

/* WASI's poll has no urgent-data bit: __header_poll.h defines POLLRDNORM,
 * POLLWRNORM, POLLIN, POLLOUT, POLLERR, POLLHUP and POLLNVAL and stops there.
 * wget asks for `POLLIN | POLLPRI` and so will not compile without one.
 *
 * NOT Linux's 0x002, which is POLLWRNORM here — a value that would quietly ask
 * for writability. An unused bit instead: nothing ever reports it, which is
 * the truth, since there is no out-of-band data on a socket made of fetch. */
#ifndef POLLPRI
#define POLLPRI 0x8
#endif

/* wasi-libc's sockaddr_un is `{ sa_family_t sun_family; }` and nothing else —
 * "WASI has no UNIX-domain sockets", says the comment above it. busybox's
 * xconnect.c names sun_path in two branches that ENABLE_FEATURE_UNIX_LOCAL
 * compiles out at runtime and the compiler still has to parse.
 *
 * Claiming wasi-libc's own guard is the same move struct winsize makes below:
 * this header is force-included first, so the definition here is the one
 * everybody sees and <sys/un.h> later finds its work already done. There are
 * still no unix sockets; there is now a member for dead code to mention. */
/* wasi-libc hides getsockname/getpeername behind __wasilibc_use_wasip2, a
 * macro whose actual meaning is "the target is wasm32-wasip2" — which this is
 * not. Defining it to unlock two declarations would also silently redefine
 * every MSG_* constant, so the two are declared here instead.
 *
 * They are the ONLY socket functions that have to be declared. busybox builds
 * with -Wno-implicit-function-declaration, so an undeclared socket() or
 * connect() is merely a warning — but get_lsa() takes the ADDRESS of these
 * two, and an implicitly-declared function has none. That is the whole of the
 * hard error, and it is worth knowing before anybody reaches for the macro. */
struct sockaddr;
int getsockname(int, struct sockaddr *, unsigned *);
int getpeername(int, struct sockaddr *, unsigned *);

#ifndef __wasilibc___struct_sockaddr_un_h
#define __wasilibc___struct_sockaddr_un_h
struct sockaddr_un { unsigned short sun_family; char sun_path[108]; };
#endif

#ifndef TIOCGWINSZ
#define TIOCGWINSZ 0x5413
#define TIOCSWINSZ 0x5414
#define TIOCGPGRP  0x540F
#define TIOCSPGRP  0x5410
#define TIOCNOTTY  0x5422
#define TIOCSCTTY  0x540E
#define TIOCMGET   0x5415
#define TIOCMSET   0x5418
#define TIOCOUTQ   0x5411
#define TIOCEXCL   0x540C
#endif

/* busybox reads TIOCGWINSZ into this (stty size, get_terminal_width_height).
 * Some wasi-libc versions declare struct winsize in <bits/alltypes.h> (guarded
 * by __DEFINED_struct_winsize) and some don't. Reuse musl's guard so we define
 * it only when the libc doesn't — and, since this header is force-included
 * first, claiming the guard also stops a later alltypes.h from redefining it. */
#ifndef __DEFINED_struct_winsize
struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
#define __DEFINED_struct_winsize
#endif

#ifndef __wasi_sigaction_shim
#define __wasi_sigaction_shim
typedef struct { int si_signo, si_errno, si_code, si_pid, si_uid, si_status; void *si_addr; } siginfo_t;
struct sigaction {
	union { void (*sa_handler)(int); void (*sa_sigaction)(int, siginfo_t *, void *); } __sa_h;
	unsigned long sa_mask; int sa_flags; void (*sa_restorer)(void);
};
#define sa_handler   __sa_h.sa_handler
#define sa_sigaction __sa_h.sa_sigaction
#ifndef SA_RESTART
#define SA_RESTART 0x10000000
#define SA_SIGINFO 0x00000004
#endif
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigemptyset(unsigned long *); int sigfillset(unsigned long *);
int sigaddset(unsigned long *, int); int sigdelset(unsigned long *, int);
int sigprocmask(int, const unsigned long *, unsigned long *);
int sigsuspend(const unsigned long *);
int kill(int, int); int killpg(int, int);
#ifndef SIG_BLOCK
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#endif
#endif
#ifndef F_DUPFD
#define F_DUPFD 0
#define F_GETFD 1
#define F_SETFD 2
#define F_GETFL 3
#define F_SETFL 4
#define F_DUPFD_CLOEXEC 1030
#endif
#ifndef FD_CLOEXEC
#define FD_CLOEXEC 1
#endif
#ifndef RLIMIT_CPU
#define RLIMIT_CPU 0
#define RLIMIT_FSIZE 1
#define RLIMIT_DATA 2
#define RLIMIT_STACK 3
#define RLIMIT_CORE 4
#define RLIMIT_RSS 5
#define RLIMIT_NPROC 6
#define RLIMIT_NOFILE 7
#define RLIMIT_MEMLOCK 8
#define RLIMIT_AS 9
#define RLIMIT_LOCKS 10
#define RLIMIT_SIGPENDING 11
#define RLIMIT_MSGQUEUE 12
#define RLIMIT_NICE 13
#define RLIMIT_RTPRIO 14
#define RLIMIT_RTTIME 15
#define RLIM_NLIMITS 16
#define RLIM_INFINITY (~0ULL)
typedef unsigned long long rlim_t;
struct rlimit { rlim_t rlim_cur, rlim_max; };
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#endif
#ifndef SOL_SOCKET
#define SOL_SOCKET 1
#define SO_REUSEADDR 2
#define SO_TYPE 3
#define SO_ERROR 4
#define SO_DONTROUTE 5
#define SO_BROADCAST 6
#define SO_SNDBUF 7
#define SO_RCVBUF 8
#define SO_KEEPALIVE 9
#define SO_OOBINLINE 10
#define SO_LINGER 13
#define SO_REUSEPORT 15
#define SO_RCVTIMEO 20
#define SO_SNDTIMEO 21
#define SO_BINDTODEVICE 25
#endif

#endif /* __ASSEMBLER__ */
#endif /* WASI_COMPAT_H */
