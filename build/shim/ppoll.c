#define _GNU_SOURCE
#include <poll.h>
#include <limits.h>
/* wasi-libc has no ppoll; busybox's read/select paths call it. The timeout MUST
 * be honored — dropping it (poll(...,-1)) makes every `read -t` block forever in
 * spirit but, because the fd is reported "ready" with 0 bytes, return instantly
 * as EOF. That destroys tuish's idle pacing (game runs at infinite fps) and its
 * input timing. Translate the timespec to a millisecond poll timeout. */
int ppoll(struct pollfd *f, nfds_t n, const struct timespec *ts, const sigset_t *m){
    (void)m;
    int ms = -1;
    if (ts) {
        long v = ts->tv_sec * 1000L + ts->tv_nsec / 1000000L;
        if (v > INT_MAX) v = INT_MAX;
        ms = (int)v;
    }
    return poll(f, n, ms);
}
