#include <errno.h>
#ifndef SIGWINCH
#define SIGWINCH 28
#endif
/* ash installs its signal catcher through sigaction(). We deliver no real
 * signals, but for SIGWINCH we CAPTURE the handler ash registers (its own
 * static signal_handler) so the poll wrapper below can invoke it when the host
 * posts a resize — a synthesized SIGWINCH with no signal layer. SIG_DFL(0) and
 * SIG_IGN(1) mean "no live trap"; store only a real function. */
static void (*winch_handler)(int);
int sigaction(int s, const struct sigaction *a, struct sigaction *o){
  if (s == SIGWINCH && a) {
    void (*h)(int) = a->sa_handler;
    winch_handler = (h == (void(*)(int))0 || h == (void(*)(int))1) ? 0 : h;
  }
  (void)o; return 0;
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
int cfsetispeed(void*t,unsigned s){ (void)t;(void)s; return 0; }
int cfsetospeed(void*t,unsigned s){ (void)t;(void)s; return 0; }
/* stty (CONFIG_STTY) reads line speed; no tty here, so report B0. Without these
 * the applet leaves cfget*speed as unresolved env imports and the module can't
 * instantiate. */
unsigned cfgetispeed(const void*t){ (void)t; return 0; }
unsigned cfgetospeed(const void*t){ (void)t; return 0; }
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
int tcgetattr(int fd,void*t){ (void)fd;(void)t; return 0; }
int tcsetattr(int fd,int o,const void*t){ (void)fd;(void)o;(void)t; return 0; }
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
