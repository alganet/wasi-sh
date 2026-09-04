#include <errno.h>
#ifndef SIGWINCH
#define SIGWINCH 28
#endif
#ifndef SIGINT
#define SIGINT 2
#endif
/* ash installs its signal catcher through sigaction(). We deliver no real
 * signals, but we CAPTURE the handlers ash registers (its own static
 * signal_handler) so the two places that can synthesize one have somebody to
 * call: the poll wrapper below, when the host posts a resize, and raise()
 * beneath it. SIG_DFL(0) and SIG_IGN(1) mean "no live trap"; store only a real
 * function. */
static void (*winch_handler)(int);
static void (*int_handler)(int);
int sigaction(int s, const struct sigaction *a, struct sigaction *o){
  if (a) {
    void (*h)(int) = a->sa_handler;
    void (*live)(int) = (h == (void(*)(int))0 || h == (void(*)(int))1) ? 0 : h;
    if (s == SIGWINCH) winch_handler = live;
    else if (s == SIGINT) int_handler = live;
  }
  (void)o; return 0;
}

/* raise(), which wasi-libc answers by ABORTING.
 *
 * That is defensible for a process that cannot handle a signal and indefensible
 * here, because the caller is usually the shell raising a signal at ITSELF and
 * the "process" is the whole session. Measured before this existed: `^C` at an
 * interactive prompt ended the shell with a wasm trap and took the terminal,
 * the filesystem and every warm runtime with it. ash does
 *
 *     write(STDOUT_FILENO, "^C\n", 3);
 *     raise(SIGINT);   // here non-blocked SIGINT will longjmp
 *
 * on an abandoned line, and had no way to survive its own answer.
 *
 * So: deliver it, the way __wrap_poll delivers a synthesized SIGWINCH. The
 * handler is ash's own, it is called on ash's own stack from ash's own call,
 * and for SIGINT it does not come back — it longjmps to the top of the command
 * loop, which is exactly what the comment above that raise() expects.
 *
 * A signal nobody registered a handler for RETURNS instead of ending anything.
 * Upstream ash already writes for that case — "raise(SIGINT) did not work!
 * (e.g. if SIGINT is SIG_IGNed on startup, it stays SIG_IGNed)" — and takes the
 * bash behaviour of a fresh prompt with 130 in $?. Killing the session would be
 * the only worse answer available. */
int __wrap_raise(int sig){
  void (*h)(int) = 0;
  if (sig == SIGINT) h = int_handler;
  else if (sig == SIGWINCH) h = winch_handler;
  if (h) h(sig);
  return 0;
}
/* Signal-mask stubs must NEVER write through their pointers: wasi-libc's
 * sigset_t is `typedef unsigned char` (a 1-byte placeholder), so callers
 * allocate 1 byte for a mask. A 4-byte store here smashes whatever the
 * compiler placed next to it — in busybox's check_got_signal_and_poll that
 * is the ppoll timespec, which silently zeroed the whole-seconds part of
 * every `read -t` timeout. Nothing ever reads a mask (no signals exist),
 * so pure no-ops are correct. */
int sigemptyset(unsigned long *m){ (void)m; return 0; }
int sigfillset(unsigned long *m){ (void)m; return 0; }
int sigaddset(unsigned long *m,int n){ (void)m;(void)n; return 0; }
int sigdelset(unsigned long *m,int n){ (void)m;(void)n; return 0; }
int sigprocmask(int h,const unsigned long *s,unsigned long *o){ (void)h;(void)s;(void)o; return 0; }
int sigsuspend(const unsigned long *m){ (void)m; errno=EINTR; return -1; }
int kill(int p,int s){ (void)p;(void)s; return 0; }
int killpg(int p,int s){ (void)p;(void)s; return 0; }
int chown(const char*p,unsigned u,unsigned g){ (void)p;(void)u;(void)g; return 0; }
int lchown(const char*p,unsigned u,unsigned g){ (void)p;(void)u;(void)g; return 0; }
int fchown(int f,unsigned u,unsigned g){ (void)f;(void)u;(void)g; return 0; }
extern void __host_trace(int);
int fork(void){ __host_trace(1); errno=ENOSYS; return -1; }
extern int __host_pipe(int*);
int pipe(int f[2]){ return __host_pipe(f); }
int execvp(const char*f,char*const a[]){ (void)f;(void)a; errno=ENOSYS; return -1; }
int execv(const char*f,char*const a[]){ (void)f;(void)a; errno=ENOSYS; return -1; }
int execve(const char*f,char*const a[],char*const e[]){ (void)f;(void)a;(void)e; errno=ENOSYS; return -1; }
struct rlimit; 
int getrlimit(int r, struct rlimit *l){ (void)r;(void)l; return 0; }
int setrlimit(int r, const struct rlimit *l){ (void)r;(void)l; return 0; }
/* process/permission/misc stubs (browser: no users, no exec) */
int system(const char*c){ (void)c; return -1; }
unsigned getuid(void){ return 0; } unsigned geteuid(void){ return 0; }
unsigned getgid(void){ return 0; } unsigned getegid(void){ return 0; }
int setuid(unsigned u){ (void)u; return 0; } int setgid(unsigned g){ (void)g; return 0; }
int seteuid(unsigned u){ (void)u; return 0; } int setegid(unsigned g){ (void)g; return 0; }
int setreuid(unsigned a,unsigned b){ (void)a;(void)b; return 0; }
int setregid(unsigned a,unsigned b){ (void)a;(void)b; return 0; }
int initgroups(const char*u,unsigned g){ (void)u;(void)g; return 0; }
int setgroups(unsigned long n,const unsigned*g){ (void)n;(void)g; return 0; }
void *getpwnam(const char*n){ (void)n; return 0; }
void *getpwuid(unsigned u){ (void)u; return 0; }
void *getgrnam(const char*n){ (void)n; return 0; }
void *getgrgid(unsigned g){ (void)g; return 0; }
void *getpwent(void){ return 0; } void setpwent(void){} void endpwent(void){}
void *getgrent(void){ return 0; } void setgrent(void){} void endgrent(void){}
int dup(int fd){ return fd; }
int getgroups(int n,unsigned*g){ (void)n;(void)g; return 0; }
unsigned umask(unsigned m){ (void)m; return 0; }
int setpgid(int a,int b){ (void)a;(void)b; return 0; }
int setsid(void){ return 0; }
int tcsetpgrp(int fd,int p){ (void)fd;(void)p; return 0; }
int tcgetpgrp(int fd){ (void)fd; return 0; }
#include <errno.h>
/* The termios family, with the REAL prototypes rather than void*-typed
 * look-alikes: the line-discipline state below has to be a `struct termios`,
 * and once <termios.h> is in scope every declaration in it has to be matched.
 *
 * Line speed is the one part that stays fictional. There is no line, so a
 * speed set is accepted and dropped and a speed read reports B0 — which is
 * what stty (CONFIG_STTY) printed before this file held any state at all.
 * Without these four the applet leaves cf*speed as unresolved env imports and
 * the module cannot instantiate. */
#include <termios.h>
int cfsetispeed(struct termios*t,speed_t s){ (void)t;(void)s; return 0; }
int cfsetospeed(struct termios*t,speed_t s){ (void)t;(void)s; return 0; }
speed_t cfgetispeed(const struct termios*t){ (void)t; return 0; }
speed_t cfgetospeed(const struct termios*t){ (void)t; return 0; }
int clock_settime(int c,const void*t){ (void)c;(void)t; return 0; }
void *getmntent(void*f){ (void)f; return 0; }
void *setmntent(const char*f,const char*m){ (void)f;(void)m; return 0; }
int endmntent(void*f){ (void)f; return 1; }
int getlogin_r(char*b,unsigned n){ if(n){b[0]=0;} return 0; }
char *mktemp(char*t){ return t; }
char *mkdtemp(char*t){ (void)t; return 0; }
/* dev_t is u64 on wasm32-wasi; a narrower stub is a wasm signature mismatch
 * that traps at the call site (cp's special-file branch references this). */
int mknod(const char*p,unsigned m,unsigned long long d){ (void)p;(void)m;(void)d; errno=ENOSYS; return -1; }
int setresgid(unsigned a,unsigned b,unsigned c){ (void)a;(void)b;(void)c; return 0; }
int setresuid(unsigned a,unsigned b,unsigned c){ (void)a;(void)b;(void)c; return 0; }
/* Line discipline, as a value rather than a device. There is no tty and no
 * kernel to hold these bits, so this file holds them: one process-wide
 * `struct termios` that tcgetattr reads and tcsetattr writes back.
 *
 * It has to be a real struct and not the no-op pair this used to be, for one
 * reason that decides the whole feature. lineedit.c gives up on editing when
 *
 *     (initial_settings.c_lflag & (ECHO|ICANON)) == ICANON
 *
 * which is the "somebody ran `stty -echo` before us" test. A no-op tcgetattr
 * leaves the caller's struct as get_termios_and_make_raw() memset it — all
 * zeroes — so the test read 0 == ICANON and happened to say "keep editing".
 * The right answer by accident: the same zeroes claim a terminal with no ECHO,
 * no ISIG and VMIN/VTIME of 0, and `stty` printed that fiction to the user.
 *
 * Seeded to what a cooked terminal actually looks like, the test means what
 * POSIX says: with ECHO|ICANON both set the editor engages, and after a real
 * `stty -echo` it correctly falls back to a plain read. Nothing here has to
 * ENFORCE the bits — the shim performs no echo and no canonicalization either
 * way, so the only reader that matters is the guest asking what it set. */
#include <string.h>
static struct termios tty_state;
static int tty_state_ready;
static void tty_state_init(void){
  if (tty_state_ready) return;
  tty_state_ready = 1;
  memset(&tty_state, 0, sizeof(tty_state));
  tty_state.c_iflag = ICRNL | IXON | BRKINT | IMAXBEL;
  tty_state.c_oflag = OPOST | ONLCR;
  tty_state.c_cflag = CS8 | CREAD | B38400;
  tty_state.c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN;
  tty_state.c_cc[VINTR] = 3;    /* ^C */
  tty_state.c_cc[VQUIT] = 28;   /* ^\ */
  tty_state.c_cc[VERASE] = 127; /* DEL */
  tty_state.c_cc[VKILL] = 21;   /* ^U */
  tty_state.c_cc[VEOF] = 4;     /* ^D */
  tty_state.c_cc[VSTART] = 17;  /* ^Q */
  tty_state.c_cc[VSTOP] = 19;   /* ^S */
  tty_state.c_cc[VSUSP] = 26;   /* ^Z */
  tty_state.c_cc[VMIN] = 1;
  tty_state.c_cc[VTIME] = 0;
}
int tcgetattr(int fd,struct termios*t){ (void)fd; tty_state_init(); memcpy(t,&tty_state,sizeof(tty_state)); return 0; }
int tcsetattr(int fd,int o,const struct termios*t){ (void)fd;(void)o; tty_state_init(); memcpy(&tty_state,t,sizeof(tty_state)); return 0; }
int vfork(void){ errno=ENOSYS; return -1; }
int wait(int*s){ (void)s; errno=ECHILD; return -1; }
int waitpid(int p,int*s,int o){ (void)p;(void)s;(void)o; errno=ECHILD; return -1; }
int execlp(const char*f,const char*a,...){ (void)f;(void)a; errno=ENOSYS; return -1; }
int execl(const char*f,const char*a,...){ (void)f;(void)a; errno=ENOSYS; return -1; }
extern int __host_dup2(int,int);
int dup2(int o,int n){ return __host_dup2(o,n); }
int getpgrp(void){ return 0; }
int getppid(void){ return 1; }
extern int __host_dup(int fd,int minfd);
extern int __real_fcntl(int fd,int cmd,...);
#include <stdarg.h>
int __wrap_fcntl(int fd,int cmd,...){
  va_list ap; va_start(ap,cmd); long arg=va_arg(ap,long); va_end(ap);
  if(cmd==0/*F_DUPFD*/||cmd==1030/*F_DUPFD_CLOEXEC*/){ int r=__host_dup(fd,(int)arg); if(r<0) errno=EBADF; return r; }
  if(cmd==1/*F_GETFD*/||cmd==3/*F_GETFL*/) return 0;
  if(cmd==2/*F_SETFD*/||cmd==4/*F_SETFL*/) return 0;
  return __real_fcntl(fd,cmd,(int)arg);
}

/* Terminal geometry for a RUNNING guest. wasm has no signals and there is no
 * PTY, so size travels through the host winsize slot (see ring.mjs/shim.mjs):
 * __host_winsize() fills the live rows/cols. `stty size` and busybox's
 * get_terminal_width_height() call ioctl(TIOCGWINSZ); --wrap ioctl routes them
 * here. Any other request is ENOTTY — busybox needs no other ioctl once size
 * works (line modes go through the tcgetattr/tcsetattr stubs above), and not
 * touching __real_ioctl means we don't depend on wasi-libc providing one. */
extern void __host_winsize(int *rows, int *cols);
int __wrap_ioctl(int fd, unsigned long req, ...){
  (void)fd;
  if (req == TIOCGWINSZ){
    va_list ap; va_start(ap, req); struct winsize *ws = va_arg(ap, struct winsize *); va_end(ap);
    int r = 0, c = 0; __host_winsize(&r, &c);
    if (r <= 0 || c <= 0){ errno = ENOTTY; return -1; }  /* unknown: caller falls back to $LINES/$COLUMNS */
    ws->ws_row = (unsigned short)r; ws->ws_col = (unsigned short)c;
    ws->ws_xpixel = ws->ws_ypixel = 0;
    return 0;
  }
  errno = ENOTTY; return -1;
}

/* Synthesized SIGWINCH. The host raises a pending-winch flag on resize (and
 * wakes the parked poll_oneoff by bumping the ring seq). __host_winch() reports
 * and clears that flag; when set we call ash's captured handler, which just
 * records pending_sig=SIGWINCH — exactly what a real signal would do. ash then
 * runs the trapped WINCH action at its next dotrap checkpoint (between the
 * commands of tuish's event loop), and `stty size` returns the fresh dims.
 *
 * The chokepoint is poll(): tuish's `read -t` waits there (busybox safe_poll),
 * and --wrap poll routes every poll — including the one inside our ppoll.c — to
 * this wrapper, so the dispatch fires no matter which timed-wait path is used.
 * ash's handler only sets flags (no longjmp for non-INT signals), so invoking
 * it synchronously at poll return is safe.
 *
 * An UNTIMED poll is the idle shell: busybox polls with -1 rather than blocking
 * in read() precisely so a signal can interrupt it, and the host honors that by
 * parking in poll_oneoff and returning EINTR when a resize ends the park. That
 * EINTR is ours to justify — it must not surface in a shell that never asked
 * for WINCH, or an ordinary `read` would fail whenever the window changed. So
 * the dispatch reports whether it reached a handler, and a wake that delivered
 * nothing is retried here instead of being handed up. */
#include <poll.h>
#include <errno.h>
extern int __host_winch(void);
/* ash's signal_handler (what we captured) sets THREE things: gotsig[]/pending_sig
 * — which make dotrap run the WINCH trap, exactly what we want — and libbb's
 * bb_got_signal, a flag read by check_got_signal_and_poll (the `read -t` wait).
 * bb_got_signal is only ever cleared on the interactive line-editing path, never
 * for the `read` builtin, so once set it makes every subsequent `read -t` return
 * EINTR without polling — an infinite busy-spin. Since no real signals exist
 * here, bb_got_signal is ours to manage: clear it right after delivery, keeping
 * gotsig/pending_sig so the trap still fires at ash's next dotrap. */
extern signed char bb_got_signal;   /* libbb `smallint` = signed char */
/* Returns 1 when a resize was delivered to a handler — i.e. when the EINTR that
 * carried us here has someone to be EINTR for. */
static int winch_dispatch(void){
  if (__host_winch() && winch_handler) {
    winch_handler(SIGWINCH);
    bb_got_signal = 0;
    return 1;
  }
  return 0;
}
extern int __real_poll(struct pollfd *f, nfds_t n, int timeout);
int __wrap_poll(struct pollfd *f, nfds_t n, int timeout){
  for (;;) {
    int r = __real_poll(f, n, timeout);
    int e = errno;                  /* read it BEFORE the dispatch: the handler
                                     * we are about to call is arbitrary code. */
    int delivered = winch_dispatch();
    errno = e;
    if (r >= 0 || e != EINTR) return r;
    /* EINTR with a handler served: the caller wanted to know. Interactive line
     * editing retries and keeps its half-typed line; `read` reports failure,
     * which is what a trapped signal does to it on any other system. */
    if (delivered) return r;
    /* Nobody was listening. Re-park rather than failing the caller's read —
     * but never re-arm a timed poll, whose deadline we would silently double.
     * This cannot spin: the dispatch consumed the pending flag on its way
     * through __host_winch(), so the next poll parks on an empty ring. */
    if (timeout >= 0) return r;
  }
}

/* ---- in-process applet support (see ARCHITECTURE.md) ---- */
#include <string.h>
#include <fcntl.h>
#include <wasi/api.h>
/* Raw exit() inside an in-process applet must not kill the whole shell:
 * run_nofork_applet() installs die_func (a longjmp back to the shell); route
 * exit() through it, exactly like xfunc_die() does. Outside an applet
 * die_func is NULL and the real exit proceeds (ash's own `exit`). Linked
 * with --wrap exit. */
extern void (*die_func)(void);
extern unsigned char xfunc_error_retval; /* uint8_t in libbb — a wider store clobbers neighbors */
extern void __real_exit(int);
void __wrap_exit(int code){
  if (die_func) { xfunc_error_retval = (unsigned char)code; die_func(); }
  __real_exit(code);
}

/* ---- cooperative interrupt: the applet half (see ARCHITECTURE.md) ----
 * wasm cannot be signalled, so a ^C is a monotonic COUNT the host raises in
 * the stdin ring and a wake (ring.mjs, Session.interrupt()). __host_interrupt()
 * reads it. A count rather than a flag because there is nothing to consume it:
 * the work in flight records the value it started at and compares, so an
 * interrupt reaches exactly that work and an interrupt posted while nothing is
 * running cancels nothing. Identical to what ctx.interrupted() gives a host
 * builtin, one layer down.
 *
 * The bail is busybox's own: die_func is the longjmp run_nofork_applet
 * installs for a dying xfunc, and every global the applet scribbled on is
 * restored on the way out. 130 is 128+SIGINT, which is what a script reads in
 * $? for an interrupted command.
 *
 * enter/done/leave are called by build/applet-interrupt.patch, at
 * run_nofork_applet and NOT at the shell — outside an applet die_func is NULL
 * and there is nothing here to longjmp to. Nesting is counted because xargs and
 * find -exec run their children through the same function: a nested baseline
 * would hand the child a fresh count and lose an interrupt posted before it
 * started. */
extern int __host_interrupt(void);
static int intr_count0;      /* the count when the OUTERMOST applet started */
static unsigned intr_depth;  /* applet nesting (xargs, find -exec) */
static int intr_quiet;       /* this frame is past the point of cancelling */
static int intr_partial;     /* the last real write was short: a retry is live */
/* The sampling counter behind bb_intr_poll() (libbb.h). An interpreter's
 * innermost loop cannot afford a cross-TU call plus an import on every turn —
 * measured at 13% of awk's throughput — and does not need one: 256 turns is a
 * few microseconds, which is not a latency anybody can perceive in a ^C. The
 * I/O safe points call bb_intr_check() directly, because a read or a write is
 * already orders of magnitude dearer than the check. */
unsigned bb_intr_ticks = 1;
#define INTR_SAMPLE 256
void bb_intr_enter(void){ bb_intr_ticks = 1; intr_partial = 0; if (intr_depth++ == 0) intr_count0 = __host_interrupt(); }
/* No more cancelling in this frame. Raised by a bail on its way out, so the
 * unwinding frame cannot fire again on its own cleanup, and by the patch once
 * the applet has RETURNED: its status is decided and its buffered output still
 * has to reach the descriptors it ran under, so a ^C landing during that flush
 * would throw away a command that had already finished. */
void bb_intr_done(void){ intr_quiet = 1; }
void bb_intr_leave(void){ if (intr_depth) intr_depth--; intr_quiet = 0; }
void bb_intr_check(void){
  bb_intr_ticks = INTR_SAMPLE;
  if (!intr_depth || intr_quiet || intr_partial || !die_func) return;
  if (__host_interrupt() == intr_count0) return;
  intr_quiet = 1;
  xfunc_error_retval = 130;
  die_func();                /* longjmp — does not return */
}

/* The safe points. read/write carry libbb's own loops (safe_read, full_write);
 * readv/writev carry stdio's, which is what every applet that printf()s goes
 * through — miss those and `seq 1 100000000` is uninterruptible. Wrapped at
 * libc rather than in busybox so no applet needs to know this exists.
 *
 * Checked BEFORE the call, never after: a longjmp out of the middle of stdio's
 * flush leaves bytes the FILE still believes are unwritten, and the next flush
 * emits them a second time. Bailing first leaves the buffer untouched, and
 * run_nofork_applet flushes it once on its way out — output produced before the
 * ^C reaches the descriptors the command ran under, not the next command's.
 *
 * Never mid-retry either, which is the same hazard one loop out. A short write
 * is real here — the shim reports one when a store refuses part of a gather —
 * and __stdio_write retries the remainder WITHOUT advancing f->wpos, so a bail
 * on the second turn would leave the FILE holding bytes that had already gone
 * out. So a short answer parks the check until a write completes. */
#include <sys/uio.h>   /* iovec + ssize_t; NOT unistd.h, whose getlogin_r
                        * prototype collides with the stub defined above */
static ssize_t intr_wrote(ssize_t r, size_t want){
  intr_partial = (r >= 0 && (size_t)r < want);
  return r;
}
extern ssize_t __real_read(int, void *, size_t);
ssize_t __wrap_read(int fd, void *buf, size_t n){ bb_intr_check(); return __real_read(fd, buf, n); }
extern ssize_t __real_readv(int, const struct iovec *, int);
ssize_t __wrap_readv(int fd, const struct iovec *v, int c){ bb_intr_check(); return __real_readv(fd, v, c); }
extern ssize_t __real_write(int, const void *, size_t);
ssize_t __wrap_write(int fd, const void *buf, size_t n){
  if (!intr_partial) bb_intr_check();
  return intr_wrote(__real_write(fd, buf, n), n);
}
extern ssize_t __real_writev(int, const struct iovec *, int);
ssize_t __wrap_writev(int fd, const struct iovec *v, int c){
  size_t want = 0; int i;
  if (!intr_partial) bb_intr_check();
  for (i = 0; i < c; i++) want += v[i].iov_len;
  return intr_wrote(__real_writev(fd, v, c), want);
}

/* sed -i and mktemp need mkstemp; emulate with O_CREAT|O_EXCL retries
 * (the shim's path_open enforces EXCL). */
int mkstemp(char *t){
  static unsigned counter;
  size_t l = strlen(t);
  int tries;
  if (l < 6) { errno = EINVAL; return -1; }
  for (tries = 0; tries < 100; tries++){
    unsigned v = counter++ + tries * 7777u; int i, fd;
    for (i = 0; i < 6; i++){ t[l-6+i] = 'a' + (v % 26); v /= 26; }
    fd = open(t, O_RDWR|O_CREAT|O_EXCL, 0600);
    if (fd >= 0) return fd;
  }
  errno = EEXIST; return -1;
}
/* Syscall-surface reduction: defining these libc entry points here keeps
 * wasi-libc's implementations (and the fd_tell / fd_renumber /
 * fd_filestat_set_size WASI imports they reference) out of the module. */
long long __wasilibc_tell(int fd){ /* lseek(fd, 0, SEEK_CUR) fast path */
  __wasi_filesize_t pos;
  __wasi_errno_t e = __wasi_fd_seek(fd, 0, __WASI_WHENCE_CUR, &pos);
  if (e) { errno = e; return -1; }
  return (long long)pos;
}
/* freopen's fd move (awk file args). Wrapped rather than defined outright:
 * current wasi-libc ships its own __wasilibc_fd_renumber.o, and defining the
 * bare name here collides with it at link time. --wrap sends every reference
 * to this version and leaves libc's copy unreferenced. */
int __wrap___wasilibc_fd_renumber(int fd,int newfd){
  if (dup2(fd,newfd) < 0) return -1;
  if (fd != newfd) close(fd);
  return 0;
}
int ftruncate(int fd,long long len){ (void)fd;(void)len; errno=ENOSYS; return -1; }
int truncate(const char*p,long long len){ (void)p;(void)len; errno=ENOSYS; return -1; }
/* referenced by enabled applets; without definitions they become unresolvable
 * env.* imports and the module cannot instantiate */
int getgrouplist(const char*u,unsigned g,unsigned*gs,int*n){ (void)u;(void)g;(void)gs; if(n)*n=0; return 0; }
int sync2(void) __asm__("sync");
int sync2(void){ return 0; }
int sched_getaffinity(int p,unsigned long s,void*m){ (void)p;(void)s;(void)m; errno=ENOSYS; return -1; }
void *popen(const char*c,const char*m){ (void)c;(void)m; errno=ENOSYS; return 0; }
int pclose(void*f){ (void)f; return -1; }

/* ---- host builtins (see ARCHITECTURE.md, build/ash-hostbuiltin.patch) ----
 * The embedder registers command names in JS; the patched find_command()
 * resolves them to CMDHOST and evalcommand() dispatches here. Two plain
 * externs, per the usual mechanism: --import-undefined turns any unresolved
 * __host_* symbol into an env.* wasm import that the JS shim supplies.
 *
 * Every parameter and both returns are i32 (pointers and ints on wasm32), so
 * there is no signature mismatch to trap on (cf. mknod's dev_t above), and
 * neither hook writes through a guest pointer, so there is no narrow-store
 * hazard either (cf. the sigset_t and xfunc_error_retval notes above).
 *
 * ash.c calls the two non-underscore wrappers below, so the busybox patch
 * stays free of any wasm-import knowledge and this file keeps sole ownership
 * of the ABI. */
/* getcwd is declared by hand rather than via <unistd.h>: this file defines its
 * own getlogin_r above with a narrower signature than wasi-libc's, so pulling
 * in unistd.h here is a conflicting-types error. <stddef.h> gets size_t and
 * declares nothing else. */
#include <stddef.h>
#include <limits.h>
extern char *getcwd(char *buf, size_t size);
#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* NAME is a NUL-terminated command word, LEN its strlen so the JS side can
 * decode a bounded slice instead of scanning linear memory for a terminator.
 * Returns 1 if the embedder registered exactly that name.
 * MUST stay cheap and side-effect free: ash calls it for every command word it
 * cannot otherwise resolve, including prehash()'s speculative per-pipeline-stage
 * lookups, and the answer is deliberately never cached (see the patch). */
extern int __host_builtin_lookup(const char *name, int len);
int host_builtin_lookup(const char *name)
{
	return __host_builtin_lookup(name, (int)strlen(name)) ? 1 : 0;
}

/* Enumerate the registry, for tab completion (build/ash-complete-hostbuiltin.patch).
 *
 * lookup() answers one name at a time, which is all find_command() ever needs
 * and all a lazy namespace can promise — so listing is a SEPARATE, OPTIONAL
 * capability rather than a widening of it. The JS side writes the i'th name
 * into BUF and returns its length, 0 past the end of the list, and 0 again when
 * the embedder implemented no names() at all. Those two are deliberately the
 * same answer: "nothing more to offer" is the only thing a caller can act on.
 *
 * The returned pointer is this file's static buffer and is valid until the next
 * call. That is enough because ash_command_name()'s one caller xstrdup()s it
 * immediately, and it keeps the ABI to a length rather than an allocation the
 * guest would have to free.
 *
 * A name too long for BUF is dropped by the JS side when it builds the list,
 * not reported here — a "skip this one" answer cannot be told apart from "the
 * list ended" through a single length, and truncating instead would offer a
 * candidate that completes to a command which does not exist. */
extern int __host_builtin_name(int index, char *buf, int len);
const char *host_builtin_name(int i)
{
	static char buf[256];
	int n = __host_builtin_name(i, buf, (int)sizeof(buf) - 1);
	if (n <= 0 || n > (int)sizeof(buf) - 1)
		return 0;
	buf[n] = '\0';
	return buf;
}

/* Run a registered builtin to completion, SYNCHRONOUSLY — a wasm import cannot
 * await, so the JS handler must not either.
 *
 * argv/envp are the usual NULL-terminated arrays of pointers to NUL-terminated
 * strings; the JS side walks them with a DataView (wasm32 => 4-byte
 * little-endian pointers). argc is passed so that walk is bounded.
 *
 * cwd comes from getcwd(), i.e. wasi-libc's own cwd — the thing the guest's
 * relative path_open()s actually resolve against, and unlike ash's $PWD not
 * something a script can overwrite.
 *
 * fds 0/1/2 already carry this command's redirections and pipeline dup2s by the
 * time we are called, so the handler just reads/writes them through the shim's
 * fd table and pipes, <, > and 2>&1 work with no extra machinery.
 *
 * Returns 0..255, or -1 when the host could not run it at all. The JS side
 * catches its own exceptions: one thrown out of a wasm import unwinds straight
 * through _start() and would kill the whole shell. */
extern int __host_builtin_run(const char *cwd, int argc, char **argv, char **envp);
int host_builtin_run(char **argv, char **envp)
{
	static char cwd[PATH_MAX];   /* .bss, zero-init: no size cost in the wasm */
	int argc = 0, r;
	while (argv[argc]) argc++;
	if (!getcwd(cwd, sizeof cwd)) { cwd[0] = '/'; cwd[1] = '\0'; }
	r = __host_builtin_run(cwd, argc, argv, envp);
	return r < 0 ? -1 : (r & 0xFF);   /* WEXITSTATUS-style clamp */
}

/* ---- sockets, over whatever the embedder puts on the other end -------------
 *
 * WASI preview1 has `sock_recv`, `sock_send` and `sock_shutdown` for
 * descriptors it was ALREADY given, and no way whatsoever to originate a
 * connection: there is no socket() and no connect(). So the four calls busybox
 * needs to reach a host are supplied here, by the usual mechanism — an
 * unresolved __host_* symbol becomes an env.* import that the JS shim answers
 * (see the `net` seam in src/shim.mjs).
 *
 * Only four cross the boundary. read(2) and write(2) do the I/O, because that
 * is what busybox's wget uses — it wraps the descriptor in a FILE* — so the
 * socket is an ordinary fd in the shim's own table and needs no send/recv of
 * its own. The rest of what xconnect.c reaches for is formatting, and is
 * answered here rather than in JS: crossing a boundary to sprintf an address
 * would be a strange thing to do.
 *
 * Addresses travel as an i32 in NETWORK byte order, which is what
 * `struct in_addr` already holds, so neither side converts and neither side
 * can convert wrongly.
 */

#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <stdlib.h>
#include <stdio.h>

extern int __host_sock_open(void);
extern int __host_sock_connect(int fd, unsigned addr, int port);
extern int __host_sock_resolve(const char *name, unsigned *addr);

int socket(int domain, int type, int protocol)
{
	(void) protocol;
	/* AF_INET/SOCK_STREAM only, and saying so here means the shim never has
	 * to. A guest asking for a datagram or a unix socket is asking for
	 * something this stack cannot become. */
	if (domain != AF_INET || type != SOCK_STREAM) { errno = EAFNOSUPPORT; return -1; }
	{
		int fd = __host_sock_open();
		if (fd < 0) { errno = EMFILE; return -1; }
		return fd;
	}
}

int connect(int fd, const struct sockaddr *sa, socklen_t len)
{
	const struct sockaddr_in *in = (const struct sockaddr_in *) sa;

	if (sa == NULL || len < (socklen_t) sizeof(*in) || sa->sa_family != AF_INET) {
		errno = EAFNOSUPPORT;
		return -1;
	}
	if (__host_sock_connect(fd, (unsigned) in->sin_addr.s_addr, ntohs(in->sin_port)) != 0) {
		errno = ECONNREFUSED;
		return -1;
	}
	return 0;
}

/*
 * `service` is always NULL here and `node` is never a numeric address:
 * xconnect.c's str2sockaddr() takes the port off the string itself and tries
 * inet_aton() before it gets this far, so what arrives is a hostname and
 * nothing else. One AF_INET answer with a zero port is therefore the whole
 * contract — the caller fills the port in afterwards.
 */
int getaddrinfo(const char *node, const char *service,
		const struct addrinfo *hints, struct addrinfo **res)
{
	struct addrinfo *ai;
	struct sockaddr_in *sin;
	unsigned addr = 0;

	(void) service;
	(void) hints;
	if (node == NULL || res == NULL) return EAI_NONAME;
	if (__host_sock_resolve(node, &addr) != 0) return EAI_NONAME;

	ai = calloc(1, sizeof *ai);
	sin = calloc(1, sizeof *sin);
	if (!ai || !sin) { free(ai); free(sin); return EAI_MEMORY; }

	sin->sin_family = AF_INET;
	sin->sin_port = 0;
	sin->sin_addr.s_addr = addr;

	ai->ai_family = AF_INET;
	ai->ai_socktype = SOCK_STREAM;
	ai->ai_protocol = 0;
	ai->ai_addrlen = sizeof *sin;
	ai->ai_addr = (struct sockaddr *) sin;
	ai->ai_next = NULL;
	*res = ai;
	return 0;
}

void freeaddrinfo(struct addrinfo *ai)
{
	while (ai) {
		struct addrinfo *next = ai->ai_next;
		free(ai->ai_addr);
		free(ai);
		ai = next;
	}
}

char *inet_ntoa(struct in_addr in)
{
	static char buf[16];
	unsigned char *b = (unsigned char *) &in.s_addr;

	sprintf(buf, "%u.%u.%u.%u", b[0], b[1], b[2], b[3]);
	return buf;
}

/*
 * Numeric always. There is no reverse resolver behind any of this, and a
 * getnameinfo() that invented a name would be inventing the one thing the
 * caller asked it to look up.
 */
int getnameinfo(const struct sockaddr *sa, socklen_t salen,
		char *host, socklen_t hostlen,
		char *serv, socklen_t servlen, int flags)
{
	const struct sockaddr_in *in = (const struct sockaddr_in *) sa;

	(void) flags;
	if (!sa || salen < (socklen_t) sizeof(*in) || sa->sa_family != AF_INET) return EAI_FAMILY;
	if (host && hostlen) snprintf(host, hostlen, "%s", inet_ntoa(in->sin_addr));
	if (serv && servlen) snprintf(serv, servlen, "%u", (unsigned) ntohs(in->sin_port));
	return 0;
}

/*
 * No alarm, and nothing to deliver one with: there are no signals here, so a
 * clock that promised to interrupt something could only lie.
 *
 * What that costs is worth stating, because `wget -T` still parses. busybox
 * enforces a timeout two ways: a poll-based countdown while the BODY
 * transfers, which works here, and a SIGALRM around connect and the response
 * header, which cannot. The gap is exactly the window where a guest could
 * otherwise wait for ever — so the deadline that matters belongs to whatever
 * implements the net, on the far side of a call this thread is parked inside.
 * sockfetch has one; a `net` of your own should too.
 */
unsigned alarm(unsigned seconds)
{
	(void) seconds;
	return 0;
}
