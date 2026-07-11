#include <errno.h>
int sigaction(int s, const struct sigaction *a, struct sigaction *o){ (void)s;(void)a;(void)o; return 0; }
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
int __wasilibc_fd_renumber(int fd,int newfd){ /* freopen's fd move (awk file args) */
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
