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
