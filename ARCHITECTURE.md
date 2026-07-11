# wasi-sh architecture

Technical companion to the [README](README.md). The user-facing story is
there; this is how the pieces actually work and why they look the way they do.

## Overview

```
run() / spawn()            main thread (or node)
   │  postMessage {wasm, files, args, env, sab? , stdin?}
   ▼
worker.mjs                 Web Worker / worker_threads
   │  WebAssembly.instantiate(module, shim.imports())
   ▼
shim.mjs (WasiShim)        WASI preview1 + env.__host_* hooks
   │
busybox.wasm               busybox ash + applets, fork-free, wasm32-wasi
```

Two stdin transports plug into the same shim `input` contract:
- `run()`: a fixed byte buffer, then EOF. No SharedArrayBuffer, no special
  headers.
- `spawn()`: a SharedArrayBuffer ring (`ring.mjs`) the worker parks on with
  `Atomics.wait`, so blocking `read` and `read -t` behave like a terminal's.

## The WASI shim (`src/shim.mjs`)

A minimal preview1 implementation (27 imports total) plus four `env.*` hooks
that back busybox's fork-free machinery.

**Filesystem.** A flat map of absolute path → node (`{type, data?, children?}`).
Writable: `O_CREAT`/`O_EXCL`/`O_TRUNC`/`O_APPEND` honored, file creation
requires an existing parent directory, and writes are copy-on-write — a
caller-mounted `Uint8Array` is never mutated. Everything dies with the run.
There are no symlinks, permissions, or timestamps; `path_readlink` answers
EINVAL ("not a symlink"), which is the truth. Every node gets a **unique
inode** lazily — busybox `find`/`cp -r` detect directory loops via `dev:ino`
pairs, and a constant ino makes every directory look like a recursion.
Directory rename rewrites the whole key-prefixed subtree (flat map).

**Pipes.** `env.__host_pipe` allocates an in-memory pipe as a chunk list;
reads drain consumed chunks and `fd_close`/`__host_dup2` free the pipe when
the last fd referencing it goes away. This is what makes fork-free `$(...)`
and pipelines possible: the guest redirects its own stdout into a pipe, runs
the code in-process, and reads the buffer back.

**stdin.** Pluggable `input` contract:
`pollReadable(ms) / read(max) / readBlocking?(max) / wait?(ms) / closed?()`.
`poll_oneoff` maps ash's `ppoll` onto it; `pollReadable(ms)` *is* the timed
wait (a second wait would double every `read -t` — a bug this codebase has
already had once). A closed stdin is reported readable so `poll` wakes and the
caller reads EOF, terminating `while read` loops.

**Clocks.** id 0 (REALTIME) is `Date.now()`; monotonic/cputime ids get
`performance.now()`, which cannot step backwards.

## The stdin ring (`src/ring.mjs`)

`Int32[head, tail, flags, seq]` header + data bytes in one SharedArrayBuffer.
`head` and `tail` are monotonic byte counters (only the data index is reduced
modulo capacity), so `head - tail` is always the unread count. `seq` is a
wakeup sequence word bumped on every producer event — consumers load it,
re-check their condition, then `Atomics.wait` on it, so an event landing
between check and wait returns immediately instead of being lost. `end()`
sets an EOF flag and bumps `seq` (EOF changes no counter, so waiting on `head`
alone would miss it).

## Fork-free ash (`build/ash-forkfree.patch`)

`fork()` is stubbed to ENOSYS; the patch reroutes the three places ash would
fork:

- **Command substitution** (`evalbackcmd`): redirect stdout into a host pipe,
  `evaltree` in-process, restore, read the buffer back. `$?` propagates;
  `exit N` inside `$()` is contained by a setjmp wrapper mirroring
  `redirectsafe()`.
- **Pipelines** (`evalpipe`): stages run **sequentially**; stage k's stdout
  buffers fully into a host pipe that becomes stage k+1's stdin. Fine for
  finite pipelines; an unbounded producer (`yes | head`) never terminates,
  and there is no backpressure or SIGPIPE.
- **Subshell isolation** (`subsh_begin`/`subsh_end`): built from ash's own
  localvar machinery — a scope snapshotting `$-` and every set variable, so
  writes revert on pop while reads see inherited values. Variables and shell
  options are isolated; functions, aliases, traps, and cwd are not.

## Busybox applets as builtins

Busybox classifies applets (see upstream `docs/nofork_noexec.txt`):
**NOFORK** (safe as a plain function call — vetted to leave no state behind)
and **NOEXEC** (safe only after a fork; may leak, scribble shared buffers, or
`exit()`, because process death cleans up). With `FEATURE_SH_STANDALONE` +
`FEATURE_SH_NOFORK`, ash resolves command names against the applet table
before PATH and calls `run_nofork_applet()` — in-process — for NOFORK
applets. `run_nofork_applet` saves/restores option parsing state, installs
`die_func` (a longjmp so `xfunc_die()` returns to the shell), and returns the
applet's status.

The valuable userland is NOEXEC, so the patch promotes **all** applets to that
dispatch path, and closes the three gaps a missing fork opens (each was found
as a real bug during bring-up):

1. **Scratch-buffer globals** — applets like grep keep their globals overlaid
   on `bb_common_bufsiz1` and assume a freshly zeroed process; the second grep
   in a session parsed its pattern as a filename. The patch zeroes the buffer
   before each in-process run.
2. **Shared stdio state** — an applet that drains stdin leaves the EOF flag
   set on the shared `FILE`; the next pipe-fed applet read zero bytes. The
   patch `clearerr()`s the three std streams before each run.
3. **Raw `exit()`** — libc exit becomes wasi `proc_exit`, which kills the
   whole instance (a JS exception unwinds the entire wasm stack — no guest
   setjmp can catch it). `build.sh` links with `--wrap exit`; the wrap in
   `wasistubs.c` routes exit through `die_func` when an applet is running
   (`awk 'BEGIN{exit 3}'` sets `$?=3` and the shell lives), and calls the real
   exit otherwise (ash's own `exit` builtin). Note `xfunc_error_retval` is a
   `uint8_t` — declaring it wider clobbers adjacent globals.

`FEATURE_PREFER_APPLETS` extends the same trick to `find -exec` and `xargs`
(via `spawn_and_wait`), so `find . -name '*.sh' -exec echo {} \;` runs its
children in-process too.

### Syscall surface

The applet set adds exactly **8 WASI imports** over the ash-only build, and
only 4 carry real logic:

| kind | imports |
|---|---|
| real (~25 lines) | `path_unlink_file`, `path_create_directory`, `path_remove_directory`, `path_rename` |
| trivial | `path_filestat_set_times` → `exists ? 0 : NOENT` (touch branches on this errno; returning success for missing paths silently breaks touch) |
| constant deniers | `path_readlink` → EINVAL, `path_symlink`/`path_link` → NOSYS (kept alive by cp's symlink branches) |

Three more were eliminated at the source: `wasistubs.c` defines
`__wasilibc_tell` (over the already-imported `fd_seek`),
`__wasilibc_fd_renumber` (as `dup2`+`close`; only caller is `freopen`, pulled
in by awk's file arguments), and ENOSYS `ftruncate` — so `fd_tell`,
`fd_renumber`, and `fd_filestat_set_size` never appear as imports. The
symlink family cannot be eliminated the same way under zig: its libc is
packaged into mega-objects (`posix.o`, `at_fdcwd.o`) that are always linked,
so defining those functions collides. A wasi-sdk build (per-function objects)
could shrink the surface further if it ever matters.

### Deliberately excluded applets

`ln`, `link`, `readlink` (no symlinks — they would only exercise the
deniers), `truncate` (sole `ftruncate` caller), `which` (searches PATH for
real files, so it cannot see applets and always lies — `command -v`/`type`
are applet-aware), `id` (group-db symbols), and everything needing processes,
sockets, `/proc`, or a real tty.

### Costs (measured)

- Binary: 1,499,136 → 1,654,313 bytes (+10%) for ~50 tools.
- Dispatch: ~26–34 µs per applet invocation (vs ~10 µs for a true ash
  builtin); 500 `seq` calls in 13 ms.
- Memory: NOEXEC applets assume process death and leak what they allocate —
  measured ~2.3 KiB retained per invocation averaged over an awk/sed/grep
  mix. One-shot `run()` doesn't care; a very long-lived REPL session grows
  slowly, and wasm memory never shrinks. Restart the session to reclaim.
- Known rough edges: `xargs -n1` fails after its first batch (repeated
  `spawn_and_wait` state bug); `xargs`/`find -exec` with a *NOEXEC* child
  (e.g. `xargs grep`) still fork-fails — only NOFORK children (`echo` etc.)
  work; `VAR=VAL applet` prefix assignments are not isolated around the
  in-process run (upstream-documented NOFORK gap); an applet that
  stdio-buffers stdin and exits early strands those buffered bytes.

## Build recipe (`build/build.sh`)

Pinned busybox tarball (SHA-256-verified) + the fork-free patch + an
ash-plus-applets config, cross-compiled with zig cc (or wasi-sdk) to plain
wasm32-wasi. Notable quirks, each earned the hard way:

- ash needs setjmp/longjmp: `-mexception-handling -mllvm -wasm-enable-sjlj`
  plus `-mllvm -wasm-use-legacy-eh=false` for the standard EH encoding.
- kbuild's per-directory `ld -r` maps to `wasm-ld --relocatable`; the final
  link is raw `wasm-ld` with `--import-undefined` (leaves the `env.__host_*`
  hooks as imports), `--wrap fcntl` (F_DUPFD → `__host_dup`), and
  `--wrap exit` (applet exit containment, above).
- `libbb/xconnect.o` is dropped from Kbuild.src (socket code; no sockets in
  wasi preview1).
- **Signal-mask stubs must never write through their pointers**: wasi-libc's
  `sigset_t` is a 1-byte placeholder typedef, and a 4-byte store from a stub
  once zeroed the seconds of every `read -t` timespec parked next to it on
  the stack. The stubs in `wasistubs.c` are pure no-ops.
- The make-driven final link fails on a zig EH-tag quirk; make output lands
  in `work/make.log` and a guard refuses to link from a half-built tree.

`npm run build:wasm` rebuilds and refuses to install a binary that fails its
smoke test (which includes an applet pipeline).

## Licensing

The JavaScript is ISC. `dist/busybox.wasm` is compiled from busybox
(GPL-2.0); `build/` carries the complete corresponding source recipe (config,
patch, build script) and `build/COPYING` is the GPL-2.0 text that must travel
with the binary.
