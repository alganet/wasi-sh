# wasi-sh architecture

Technical companion to the [README](README.md). The user-facing story is
there; this is how the pieces actually work and why they look the way they do.

## Overview

```
run() / spawn()            main thread (or node)
   │  postMessage {wasm, files, args, env, sab?, reqSab?, stdin?, requests?}
   ▼
worker.mjs                 Web Worker / worker_threads
   │  WebAssembly.instantiate(module, shim.imports())
   ▼
shim.mjs (WasiShim)        WASI preview1 + env.__host_* hooks
   │                       ▲ host builtins call back out here
busybox.wasm               busybox ash + applets, fork-free, wasm32-wasi
```

Two stdin transports plug into the same shim `input` contract:
- `run()`: a fixed byte buffer, then EOF. No SharedArrayBuffer, no special
  headers.
- `spawn()`: a SharedArrayBuffer ring (`ring.mjs`) the worker parks on with
  `Atomics.wait`, so blocking `read` and `read -t` behave like a terminal's.

The host port's inbound half (`/dev/hostreq`) is that same contract aimed the
other way, with the same two transports behind it — a second ring for `spawn()`,
a staged queue for `run()`.

## The WASI shim (`src/shim.mjs`)

A minimal preview1 implementation (27 imports total) plus `env.*` hooks: four
that back busybox's fork-free machinery (`__host_pipe`/`__host_dup`/`__host_dup2`
/`__host_trace`), two for terminal geometry (`__host_winsize`/`__host_winch`,
see "Terminal resize" below), and two for host builtins
(`__host_builtin_lookup`/`__host_builtin_run`, see "Host builtins" below).
Eight in total — and still eight with the host port and the cooperative
interrupt, which are a device and a ring word rather than imports (see "The host
port" and "Cooperative interrupt" below).

**Filesystem.** A pluggable store (see "The `fs` contract" below), defaulting
to `memoryFs(files)` — so a shim with no `fs` is the sealed in-memory sandbox
it always was. Writable: `O_CREAT`/`O_EXCL`/`O_TRUNC`/`O_APPEND` honored, file
creation requires an existing parent directory, and writes are copy-on-write —
a caller-mounted `Uint8Array` is never mutated. There are still no symlinks;
`path_readlink` answers EINVAL ("not a symlink"), which is the truth. Every
node gets a **unique inode** — busybox `find`/`cp -r` detect directory loops
via `dev:ino` pairs, and a constant ino makes every directory look like a
recursion.

**Devices are the shim's, not the store's.** `/dev/null` and `/dev/host` live
in an overlay above the store, and `/dev` is shadowed *whole* rather than entry
by entry. Two reasons: mounting a real directory must not mean writing device
nodes into somebody's project, and a name the overlay hides must not be
creatable underneath it — otherwise `mv work.txt /dev/null` writes the file to
a path `ls /dev` will never show and reports success. One registration
(`addDevice`) owns the map entry *and* the inode, so listing, stat and open
cannot answer for different sets of names.

**A store failure is an errno, never an exception.** A JS exception thrown out
of a wasm import unwinds the entire guest stack and the instance is dead — the
same hazard `--wrap exit` exists for. Every store call is wrapped, and its
Linux errno is translated to WASI's numbering at the edge: the two schemes
overlap enough to look interchangeable and disagree exactly where it hurts
(Linux `ENOENT` 2 is WASI `EACCES`). A failure carrying no errno at all
becomes `EIO`, not a comfortable `ENOENT` — "the store broke" and "the file is
not there" send a shell down very different paths.

**File offsets are shared, not copied.** POSIX gives one offset per open file
description, and `__host_dup`/`__host_dup2` copy the descriptor with `{...src}`
— so the offset lives in a cell (`pos: {v}`) that the copy shares. A plain
number gave every dup its own, and two things broke silently: `cmd > f 2>&1`
had fd 1 and fd 2 both writing from 0, interleaving over each other's bytes,
and `evalpipe`'s `fcntl(F_DUPFD,10)`/`dup2` save-restore *rewound* a
file-backed stdin between stages, re-serving bytes an earlier stage had eaten.

**Open descriptions outlive names.** A store is path-addressed, so two POSIX
properties that used to come free from holding a node reference are now
explicit. A file unlinked while open stays readable through the fd — its bytes
move onto the fd, in a shared cell for the same reason `pos` is one. And an
open fd follows its file across a rename, subtree included, because a rename
moves a name and not the file.

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

## The `fs` contract (`src/fs.mjs`)

The third pluggable seam, beside `input` and `builtins`. A store is a
path-addressed **synchronous** filesystem — synchronous because the guest is a
wasm stack frame below every call, so there is nothing to await into.

The shape is **ZenFS's `FileSystem`**, deliberately not one of our own:
`statSync` / `readdirSync` / `createFileSync` / `mkdirSync` / `rmdirSync` /
`unlinkSync` / `renameSync` / `linkSync` / `readSync(path, buf, start, end)` /
`writeSync(path, buf, offset)` / `touchSync(path, metadata)` / `syncSync()`.
Borrowing it means the ecosystem's stores work here unmodified — persistence
over OPFS or a user-granted directory, a filesystem in a `SharedArrayBuffer`,
copy-on-write layers, remote trees — and every gap in the flat map it replaced
is already a field of `InodeLike`: byte offsets, truncate, mode bits and
timestamps.

**Timestamps are why this could not wait.** The old map had none — filestat
wrote zero for atim/mtim/ctim — and anything that caches by mtime never
notices an edit. With an opcode cache validating timestamps, a script whose
mtime never moves is never reloaded, so editing a file in the shell and
reloading the page shows the old output, in a way that looks like a caching
bug somewhere else entirely.

**Mode bits are the same trap one field over, and they had the same cause.**
ZenFS makes `uid`, `gid` and `mode` *required* arguments of `createFileSync`
and `mkdirSync`; the shim passed `{}` and leaned on `memoryFs` filling them
in. Against a store that takes the contract literally — every ZenFS backend —
that is a mode of **zero** on every file and directory the shell creates.
busybox never notices, because it is alone in there and the shim enforces no
permissions at all; a second guest sharing the store cannot read one byte of
it, and reports that as whatever its own layer makes of EACCES. Creations name
their mode now (`0o644`/`0o755`, uid and gid 0), and the type says so.

**Two things stay out of a store**, both on purpose: open file descriptions
(offsets are arguments here, so the shared `pos` cell never reaches one and
cannot be got wrong by one), and devices.

**`memoryFs` is the zero-dependency default**: JS objects, copy-on-write over
the caller's `files`, state gone with the run. It is also the only store we
write. Anything else — persistence, sharing, a foreign runtime's filesystem —
is an adapter over somebody else's maintained implementation.

**Stores are injected, never ambient.** No `fs` is a sealed sandbox exactly as
before. A read-only store is a read-only shell, with nothing shell-side to
bypass it, and `files` is the one thing a mount may write into an injected
store, because passing both is an explicit request.

**The conformance suite** (`src/fs-conformance.mjs`, exported as
`wasi-sh/fs/conformance`) is what a store must do to back a shim, runner-
agnostic so it runs under `node --test`, in a browser, or from a REPL. It is
aimed inward as much as outward: a stock `@zenfs/core` backend runs the same
cases our own store does, which is what keeps "we took their shape" true
rather than merely claimed. That cross-check pays rent — it found three real
deviations in that backend, recorded as `todo` so they re-check on every
upgrade instead of turning somebody else's bug into a red build. `wasi-sh`
itself takes no dependency on ZenFS: it is a `devDependency`, tested in a job
that never touches the published artifact.

## The stdin ring (`src/ring.mjs`)

`Int32[head, tail, flags, seq, winRows, winCols, winch, intr]` header + data
bytes in one SharedArrayBuffer. `head` and `tail` are monotonic byte counters (only the
data index is reduced modulo capacity), so `head - tail` is always the unread
count. `seq` is a wakeup sequence word bumped on every producer event —
consumers load it, re-check their condition, then `Atomics.wait` on it, so an
event landing between check and wait returns immediately instead of being lost.
`end()` sets an EOF flag and bumps `seq` (EOF changes no counter, so waiting on
`head` alone would miss it). `winRows`/`winCols`/`winch` carry terminal
geometry and `intr` the cooperative interrupt — both stories are below.

**One format, two channels.** The inbound host-request ring is not a near-copy
of this one, it *is* this one: a request channel needs `head/tail/flags/seq` and
nothing else, and those are a strict subset of what stdin needs — the terminal
words simply go unused there. So `RingReader`/`RingWriter` serve both directions
with no adapter, and the wake mechanics that took a bug fix to get right exist
in one place. `createRing()` is the neutral name; `createStdinRing` is the same
function under the name it had when there was only one.

## Terminal resize: a synthesized SIGWINCH (`Session.resize`)

The env that carries `COLUMNS`/`LINES` is frozen at spawn, wasm preview1 has no
signal delivery, and there is no PTY between the terminal and the guest — so a
*running* shell cannot learn the terminal resized. tuish's entire resize path is
built on `trap ... WINCH` + `stty size`, both of which are dead in the browser
otherwise. `Session.resize(cols, rows)` revives them over the ring, without a
general signal layer — just one pending bit:

- **Live size.** `resize()` stores `cols`/`rows` in the ring header. The shim
  exposes them via `env.__host_winsize`, and `wasistubs.c`'s `__wrap_ioctl`
  answers `TIOCGWINSZ` from it (`--wrap ioctl`, so it never collides with
  wasi-libc's own `ioctl`; `CONFIG_STTY=y` is enabled so `stty size` exists).
  Every `stty size` / `get_terminal_width_height` now returns the current
  geometry. **Crucially, `spawn()` seeds the ring from the initial `COLUMNS`/
  `LINES` and then DROPS them from the guest env** — busybox's
  `get_terminal_width_height` prefers those env vars over the `ioctl` when they
  are present, so leaving them set would freeze the size and no resize would ever
  be seen. Geometry for an interactive session is the `ioctl`, not the
  environment. (`run()` keeps the env vars: it has no winsize ioctl and never
  resizes.)
- **The signal.** `resize()` also raises a `winch` flag and bumps `seq`, waking
  the guest's parked `poll_oneoff`. The chokepoint is `poll()`: tuish's `read
  -t` waits there (and `ppoll.c` delegates to it), so `--wrap poll` routes every
  timed wait through `wasistubs.c`'s `__wrap_poll`, which calls `winch_dispatch`
  on return. `env.__host_winch` reports-and-clears the flag; when set,
  `winch_dispatch` calls the SIGWINCH handler that ash registered — captured
  from the `sigaction` stub, which is the only place ash's catcher is installed.
  That handler sets `pending_sig = SIGWINCH` exactly as a real signal would, and
  ash runs the trapped action at its next `dotrap` checkpoint (between the
  commands of the event loop). No ash source patch is needed; the mechanism
  lives entirely in the shim, `wasistubs.c`, and the two `--wrap` flags.
- **Clearing `bb_got_signal`.** ash's handler also sets libbb's `bb_got_signal`,
  which `check_got_signal_and_poll` (the `read -t` wait) treats as "a signal
  arrived" and short-circuits to `EINTR` *without polling*. ash only clears it on
  the interactive line-editor path, never for the `read` builtin — so a single
  synthesized WINCH would make every later `read -t` spin. `winch_dispatch`
  therefore clears `bb_got_signal` right after delivery (it's a linkable global,
  and no real signals exist here to race it), keeping `gotsig`/`pending_sig` so
  the trap still fires. Without this, only the first resize is ever seen.

A burst of resizes coalesces: `winch` is one bit and the dims are last-write-wins,
so the guest services one WINCH at the newest size. A guest that never traps
WINCH simply drops the flag; the fresh size is still there for `stty size`.

## Cooperative interrupt (`Session.interrupt`)

wasm cannot be signalled and a live session is one synchronous `_start()` frame,
so a command that will not stop holds the worker: `terminate()` is the only
escape, and it takes the filesystem and every warm instance with it. That is a
papercut with busybox and a showstopper with a language runtime, where one
`while (true)` in a script bricks the tab.

`Session.interrupt()` is the ^C that reaches a running guest. It travels the
same way a resize does — a header word in the stdin ring, plus a `seq` bump so a
parked guest wakes — and it is deliberately **cooperative**: it cancels what
chose to look, and nothing else. A transport that could stop work which never
opted in would be `terminate()` wearing a nicer name.

- **A count, not a flag.** `intr` is monotonic and nothing consumes it. A flag
  would need a consumer, and the only consumer is whatever happens to be
  running — so an interrupt posted while nothing is (at the prompt, between two
  commands, mid-applet) would survive to cancel the *next* thing, which is a ^C
  the user never typed. With a count, work reads the value at entry and compares
  at its own safe points: an interrupt reaches exactly what was in flight when
  it was posted.
- **Where the check goes.** `__host_builtin_run` records the count before
  dispatch and hands the handler `ctx.interrupted()`. The handler runs on the
  guest's own stack, so nothing can unwind it from outside — polling is not a
  simplification, it is the only shape available. Returning 130 (128 + SIGINT)
  gives the script the `$?` it expects.
- **It does not end a blocking read.** The wake returns from `Atomics.wait`, but
  no bytes have appeared, so `pollReadable`/`readBlocking` re-park. An
  interrupt is not stdin input, and making a read fail on one would need the
  EINTR path that only the poll wrapper has.
- **Absent by default.** `interruptCount()` is an optional `input` method, so
  `run()` and any fixed stdin degrade to a permanently false `interrupted()` —
  the same "no info rather than an error" contract `winsize` follows.

**Busybox applets cannot be interrupted yet.** That half needs the check in C —
a count comparison at applet and loop boundaries, bailing through the existing
`die_func` longjmp — and a wasm rebuild. Until then a runaway `awk` still wants
`terminate()`. The transport is the same one either half reads.

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
  options are isolated; **functions, aliases, traps, cwd, and positional
  parameters are not** — a `cd`, `set --`, or function definition inside `$(...)`
  leaks to the parent. This is silent (no error); scripts that depend on a
  forking shell's full subshell isolation of those will diverge.

Why plain WASI rather than [WASIX](https://wasix.org/) (which offers real
`fork`/`exec`/threads and would erase all of the above): we prototyped on WASIX
and found it too slow and heavy to start for this use case, with a narrower
runtime story. tuish — the reason this project exists — never forks and barely
pipes, so the fork-free model costs it nothing while keeping the artifact small
and fast. Workloads that genuinely need process semantics belong on a WASIX
runtime, not here; wasi-sh will not grow them.

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
2. **Shared stdio state** — the `FILE` behind fd 0 is the *process's*, and
   both ends of an applet's use of it leaked into the next one. An applet that
   drains stdin leaves the EOF flag set, so the next pipe-fed applet read zero
   bytes; the patch `clearerr()`s the three std streams before each run. And a
   short-reading applet (`head -1`, `sed q`, `grep -m1`) pulls a whole block,
   prints part of it and returns with the rest still buffered — bytes a forked
   child would have taken with it — so the next applet read the previous one's
   leftovers as its own input. `printf 'l1\nl2\nl3\n' | head -1` printed `l1`,
   then `l2`, then `l3`. The patch `fflush(stdin)`s after each run, which on a
   pipe discards exactly what the child's death used to and on a *seekable*
   stdin does better than that: POSIX puts the file offset back where the
   reader stopped, so `{ head -1; read x; } < f` leaves `x` as the second line
   instead of losing the file to `head`'s buffer. Outermost applet only —
   `xargs` and `find -exec` run their children through the same
   `run_nofork_applet()`, and what the *parent* has buffered is still its own.
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
  in-process run (upstream-documented NOFORK gap).

## Host builtins (`build/ash-hostbuiltin.patch`)

The applet section above extends the shell's command namespace at *link* time.
This extends it at *run* time, from JS: `new WasiShim({ builtins })` takes a
`{ lookup(name), run(ctx) }` pair — the same pluggable-capability shape as
`input`, absent by default, degrading to "no such command" exactly as
`__host_winsize` degrades to "no info".

**Where ash hooks in.** `find_command()` resolves a name against functions, the
hash table, shell builtins, then the applet table. The new probe sits directly
after the applet block and before the path search — which in this build can
never succeed anyway, since the shim FS has no permission bits and `test_exec()`
therefore always fails. A hit sets a new `CMDHOST` cmdtype, and `evalcommand`
grows a `case` for it that calls the handler and `break`s; `jp` is `NULL` there,
so `waitforjob` hands back `exitstatus` and the ordinary redirection teardown
runs. `describe_command` grows a case too, so `type` says `is a host builtin`
and `command -v` prints the bare name (which round-trips: `"$(command -v x)"`
resolves back through `find_command`).

Three things about that placement are load-bearing:

- **`CMDHOST` is a distinct type, not a sentinel index inside `CMDNORMAL`.** The
  applet dispatch computes `applet_no = -index - 2` and indexes the applet table
  with it, so any negative sentinel is one reordering away from running an
  arbitrary applet. And `evalcommand`'s `default:` arm *is* the exec path — a
  cmdtype with no `case` falls into `vforkexec`, i.e. "can't fork" and a dead
  shell.
- **It never writes to `cmdtable`.** The applet branch returns before the cache
  for its own reasons; here it is stronger, because the host's command set is JS
  state that can change between two invocations. A cached `CMDHOST` entry could
  not even be flushed — `clearcmdentry` only frees `CMDNORMAL`, and `hashcd`
  would never mark it for rehash.
- **Applets win.** Registering `grep` does nothing, so what the shipped toolbox
  means cannot be changed out from under a script. Moving the probe above the
  applet block would invert that; it is a one-line change if the trade ever
  looks different.

**The ABI is two i32-only imports**, declared in `build/shim/wasistubs.c` so the
busybox patch carries no wasm knowledge at all:

    __host_builtin_lookup(name, len)          -> 0 | 1
    __host_builtin_run(cwd, argc, argv, envp) -> 0..255 | -1

Nothing is written through a guest pointer and there is no u64, so neither the
`mknod` `dev_t` trap nor the narrow-store hazards documented in that file apply.
`envp` comes from `listvars(VEXPORT, VUNSET, varlist.list, NULL)` — the same
call the applet branch makes, so exports *and* `VAR=x cmd` prefixes are visible;
the shim's own `env` is frozen at construction and would be permanently stale.
`cwd` comes from `getcwd()`, i.e. wasi-libc's cwd, which is what the guest's own
relative `path_open`s resolve against and which — unlike `$PWD` — a script
cannot lie about.

**Why the handler's stdio must go through the fd table.** By dispatch time
`redirectsafe()` and the fork-free `evalpipe`'s `dup2` dance have already put
this command's redirections on fds 0/1/2. So `ctx.stdout` calls `writeFd(1, …)`,
which routes on the fd's *table type* — pipe, file, or terminal. Calling the
shim's `stdout` callback instead would print `cmd | grep x` straight past grep
to the terminal and hand grep an empty pipe: the same fd-number-vs-fd-type
mistake `poll_oneoff` made once. That is why `fd_read`/`fd_write` were split
into iovec scatter/gather around reusable `readFd`/`writeFd`.

**Cancelling one.** The handler runs on the guest's own stack, so nothing can
unwind it from outside and there is no safe point but the ones it picks itself.
`__host_builtin_run` reads the ring's interrupt count before dispatch and hands
the handler `ctx.interrupted()`, which compares against it — see "Cooperative
interrupt" above for why that baseline is what keeps a ^C typed at the prompt
from cancelling the command typed after it.

**Containment.** A JS exception thrown out of a wasm import unwinds the entire
guest stack — the instance is dead, and no guest `setjmp` can catch it (the same
reason `--wrap exit` exists for applets). So `run` is wrapped: a throw writes
`name: message` to fd 2 and returns a status, and the shell survives. A nested
`WasiExit` is caught there too — letting it escape would make an inner module's
`exit(1)` silently become the *outer* shell's exit code, since `worker.mjs`
reads a `WasiExit` as a clean shutdown. The status is masked to 8 bits like
`wait(2)`. And because a thenable coerces to i32 `0` at the boundary — silent
success, with the real output landing later against whatever fd 1 has become —
returning a promise is reported as an error instead.

**Browsers need `serve()`.** Handlers are functions and `postMessage`
structured-clones its payload, so `builtins` cannot cross into a worker. `src/worker.mjs`
exports `serve({ builtins })` for a custom worker module, reached through the
existing `workerUrl` option. It must be called synchronously at module
evaluation: a task cannot interleave with synchronous script execution, so a
synchronous call always wins the startup message, whereas a module that
top-level-awaits first hands that message to a shell with no builtins. `serve()`
detects the late call and fails loudly. The factory form (`async builtins()`) is
awaited before instantiation, which is where an expensive boot belongs — that
split is what lets a builtin be backed by a second wasm module: async once, then
synchronous per invocation.

**Independent fix in the same patch.** A command name containing a slash took
`find_command`'s slash short circuit, reached `vforkexec()`, and died on
`vfork() == ENOSYS` with `can't fork` and status 2 — which is `EXERROR`, so it
*aborted the whole script*: `./x.sh; echo $?` never reached the echo. It now
reports 127 like any other miss and carries on. Host builtins are deliberately
**not** reachable by path; a virtual `/bin` would imply `[ -x ]`, shebangs and
PATH ordering, none of which exist here.

**What still does not work**, because host builtins are builtins: `exec cmd`
(`shellexec` never consults the table — note `exec date` *does* work via its
applet branch, so this is an asymmetry, and ~5 lines would close it),
`find -exec cmd` and `xargs cmd` (libbb `spawn_and_wait` has its own applet
check), and `cmd &` / `(cmd)` (still `forkshell`). Async handlers are out of
scope entirely — that would need a SAB request/response ring, a separate
mechanism.

## The host port (`/dev/host`)

The fourth pluggable seam, beside `input`, `fs` and `builtins` — and the first
aimed *outward*, at the browser rather than at the shell. One capability
object, one virtual device, verbs instead of a hook per feature:

```js
serve({ host: { request(verb, payloadBytes) { /* -> bytes */ } } })   // in the worker
```
```sh
printf 'clipboard.read\n' > /dev/host
paste=$(cat /dev/host)
```

**Nothing in the wasm changes**, which is the point. Guest → host synchronously
is the direction that was already solved — a host builtin is exactly that shape
— so the port needs no shared memory, no `Atomics.wait`, no cross-origin
isolation and no new import. `/dev/host` is an ordinary path reached through
`path_open`, `fd_read` and `fd_write`, and a script talks to it with `echo` and
`cat`.

**Framing is by line, not by write boundary**, because a write boundary is not
one: stdio splits a long payload at its buffer size and the guest's own
`printf` decides where. A verb runs to the first space; the rest of the line is
the payload, verbatim. A blank line is nothing; a line with no verb fails the
write. An unterminated line is capped — `yes > /dev/host` completes no request
and would otherwise grow a buffer until the tab dies.

**The buffers belong to the shim, not to the fd.** A request and its answer are
two commands, so two opens — and a fork-free shell restores a redirection with
`dup2`, which replaces an fd's record without `fd_close` ever seeing it. Nothing
per-descriptor could survive between the two halves of a single exchange.

Which makes the queue's lifetime the interesting question, and it is **one
open, one exchange**. A new open drops whatever the last one left — a queued
answer and a half-written line both — while writes through the same open
accumulate. An answer nobody read must not arrive prepended to somebody else's,
which for a capability port is a leak sideways rather than a surprise; and a
fragment must not be merged into the next command's request, fabricating one
neither wrote. But a batch legitimately arrives as many writes (`cat
requests.txt > /dev/host` is one redirection), which is the same reason a
partial line is held at all — so the boundary cannot be the write.

The identity used is the **offset cell**: `path_open` makes a fresh one per
open and `dup`/`dup2` share it, which is precisely POSIX's open file
description. It was already there for file offsets and already means the right
thing, so a device is simply handed it.

A **failed** write also drops what it just produced, for a different reason: it
told the guest that none of this happened, and the response is exactly the
signal a script is asked to trust. Side effects cannot be taken back, which is
why a failing line stops the batch rather than letting the rest run.

**Security is a property of the port.** No `host` and the device is still there,
refusing every open with `EPERM`: *"this session did not grant it"* and *"this
build has no port"* are different answers, and only the second should be
indistinguishable from a name that does not exist. Refusing at open rather than
at the first read matters too — a silent EOF reads as an empty answer. Hand
over an object implementing only `clipboard.*` and that is the whole reachable
surface; there is nothing shell-side to widen it, exactly as a read-only store
is a read-only shell.

**Containment mirrors the builtin path**, for the same reason: a JS exception
out of a wasm import unwinds the entire guest stack and the instance is dead. A
verb that throws, returns a thenable, or answers with something that is not
bytes fails one write with `EIO`. Two details are specific to a device:

- **Diagnostics go to the stderr *sink*, never through `writeFd(2)`.** fd 2 can
  be redirected onto this very device (`cmd > /dev/host 2>/dev/host`), and an
  error written there would re-enter the port in the middle of a dispatch. The
  sink cannot be redirected, so there is no reentrancy to guard against.
- **Payloads and responses are both copied.** A payload is a slice of the
  guest's linear memory, which `memory.grow` can detach and the guest overwrites
  immediately; a response may come from a handler's reused scratch buffer.

**A device sees one write, never a scatter.** `fd_write` gathers iovecs and,
when a later buffer fails after an earlier one landed, reports a *short write* —
which asks the caller to send the remainder again. That protocol assumes the
bytes it disclaims were never acted on, and a device has already acted: the
retry would run a verb the port had just run. So the iovecs are joined and a
device write is one call with one result, the way a character device's
`write(2)` reads to the program making it. That is also what makes the failure
reach `$?` from a buffered writer, whose flush is a two-iovec `writev` of the
`FILE` buffer plus the caller's bytes: `echo verb > /dev/host || handle_it`
works, and so does the same line with `printf`.

**Devices got two capabilities for this**, both general: a device may refuse an
open, and a device write may fail instead of every one being reported as
delivered. Registration is `shim.addDevice(path, device)`, which assigns the
inode itself so that `ls /dev`, stat and open can never describe different sets
of names.

## The inbound half (`/dev/hostreq`)

Everything above is the guest calling out. Inbound is the host handing a request
to a script that is **already running**, and it is a different problem entirely:
a live session is one synchronous `_start()` frame, so the worker's event loop
never turns while the shell runs and a `postMessage` into it is not slow — it is
not delivered (measured: posted at +303 ms, handled at +3020 ms, and only
because an unrelated wait expired). The request has to arrive through shared
memory the guest reads at a blocking point.

Which is why this is a **device and not a verb**: a verb is the guest calling
out, and here the guest is waiting to be told. The whole of a dev server is then
an ordinary shell loop, on the filesystem the shell already owns:

```sh
while read -r req <&3; do
    printf 'respond %s\n' "$(handle "$req")" > /dev/host
done 3< /dev/hostreq
```
```js
session.post('GET /index.php');   // spawn({ requestBufferSize })
```

**The channel is `input`'s contract aimed the other way** — park, read, EOF —
so a `RingReader` over a second ring serves it unchanged, and `readFd`'s stdin
path is shared rather than copied. `run()` stages the whole queue up front
instead, because nothing can arrive *during* a run(): the guest holds the thread
for its entire life.

**Framing is the line the outbound half already settled**, and the reply is an
ordinary outbound verb — one direction per device, and no second vocabulary in
the same port. A request the guest is still handling has nothing to return yet,
which is why `post()` is fire-and-forget.

**End-of-stream and error signalling, in the shell's own terms.** A request
arriving *at* a parked guest has no write to fail and no `$?` to reach, so the
delivery shape has to carry its own — and it carries exactly two answers:

| | what it means |
|---|---|
| `EPERM` at open | this session can **never** receive a request; the loop refuses to start |
| EOF at read | no more are coming; `read` fails and the loop ends |

There is no third, deliberately. Every other failure — a newline inside a
request, one too big for the ring — is refused at the producer, where the host
still holds it and can do something about it. The ring's capacity *is* the size
cap, so inbound needs no line cap of its own; overflow means the guest is not
consuming, which is the host's problem to size.

**Devices got a third capability for this, and it is general**: a device may
offer `poll(ms)`, and its presence is what stops `poll_oneoff` reporting the fd
readable on sight. That mattered enough to be a bug already — a queued resize
was undelivered for as long as you cared to wait because `poll_oneoff` answered
"readable" immediately and the wait then happened in `fd_read`, where nothing
dispatches. A device whose read can block is that same trap with a new door. Its
read may also answer an errno rather than bytes, which is how it says `EAGAIN`
when an empty read already means EOF.

**Measured:** a guest parked between requests is woken and has handled the
request in **under a millisecond**, and costs no CPU while parked.

**What this still is not.** Only a guest parked *on the request channel* is
woken. A shell idling at an interactive prompt is parked on stdin and will not
notice a request until something else wakes it — which is fine, because a dev
server is a script, not a prompt. And a blocking verb freezes that guest for its
duration, inbound or outbound, exactly like a blocking read.

## Build recipe (`build/build.sh`)

Pinned busybox tarball (SHA-256-verified) + the fork-free patch + the
host-builtin patch (applied unconditionally: it depends on none of the
fork-free machinery, and carries the slashed-name fix) + an
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
