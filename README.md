# wasi-sh

[![npm](https://img.shields.io/npm/v/wasi-sh.svg)](https://www.npmjs.com/package/wasi-sh)
[![CI](https://github.com/alganet/wasi-sh/actions/workflows/ci.yml/badge.svg)](https://github.com/alganet/wasi-sh/actions/workflows/ci.yml)

Run **shell scripts in the browser** (and node) — busybox `ash` plus a set of
coreutils, compiled to plain `wasm32-wasi`, fork-free. Pipes, command
substitution, `grep`/`sed`/`awk`/`find`, `read -t` timing: a real
POSIX-flavored shell with a real toolbox, in-process, no server.

```js
import { run } from 'wasi-sh';

const { stdout, exitCode } = await run({
  command: 'seq 20 | awk "$1 % 3 == 0" | sort -rn | head -n 2',
});
// stdout === '18\n15\n'
```

That works on **any static host with no special headers** — non-interactive
execution never blocks on the user, so it needs no `SharedArrayBuffer`.

## Install

```sh
npm install wasi-sh
```

Zero dependencies. The `.wasm` ships inside the package, so there is nothing
to fetch at runtime and no CDN to point at. Node 20+, or any modern browser.

## Two ways to use it

### `run()` — execute a script, collect output

```js
const result = await run({
  script: mySh,                 // mounted at /main.sh   (or command:, or args:)
  stdin: 'fixed input\n',       // optional; the guest reads it, then EOF
  files: { '/data/in.txt': '…' },
  env: { LC_ALL: 'C' },
  onOutput: (bytes, channel) => {},   // optional streaming ('stdout' | 'stderr')
});
// -> { stdout, stderr, exitCode }
```

- In a browser, the work runs off-thread in a plain `postMessage` Worker.
- In node it runs inline by default — `run()` doubles as a hermetic
  shell-script runner for tests and CI (`import { runScript } from 'wasi-sh/node'`).

### `spawn()` — an interactive session

```js
import { spawn } from 'wasi-sh';

const session = await spawn({ env: { COLUMNS: '80', LINES: '24' } });
session.onOutput((bytes, channel) => render(bytes)); // shell → you
session.write('echo hi\n');                          // you → shell
session.resize(100, 40);  // terminal resized: live size + a synthesized SIGWINCH
session.post('GET /');// a host request → the running guest (needs requestBufferSize)
session.interrupt();  // cooperative ^C into whatever is running
session.end();        // stdin EOF
session.terminate();  // hard kill (exited resolves 137, kill -9 style)
await session.exited; // exit code — always settles, even after terminate()
```

`spawn()` parks the shell in a Worker on a `SharedArrayBuffer` stdin ring
(`Atomics.wait`), so the guest's blocking `read` and timed `read -t` behave
like a real terminal's. That is the one thing that **requires cross-origin
isolation** — see [Deployment](#deployment-cross-origin-isolation).

## The toolbox

Everything runs **in-process** — commands are dispatched as function calls
into the busybox applets compiled into the wasm, never as processes:

- **Files**: `cat ls stat touch mkdir rmdir rm cp mv find du mktemp`
- **Text**: `grep sed awk sort uniq cut tr head tail wc seq paste fold tac
  expr hexdump xxd`
- **Hashes**: `md5sum sha1sum sha256sum cksum crc32`
- **Misc**: `date env printenv basename dirname realpath test printf getopt
  uname nproc stty` — plus every ash builtin (`echo`, `read`, `[`, arithmetic,
  globs, functions), and `compgen` for completing a word from outside the
  shell's own line editor

You can add to that list: see [Host builtins](#host-builtins-your-own-commands)
for registering your own commands, written in JS.

`command -v NAME` / `type NAME` tell you what exists. `find -exec` and
`xargs` work for simple children like `echo`. The filesystem you mount via
`files:` is **writable inside the sandbox** (copy-on-write — your buffers are
never touched; everything vanishes when the run ends), so
`grep -r`, `sed -i`, redirects, and `/tmp` scratch files all behave normally.

## The filesystem: bring your own

`files:` seeds the default in-memory store. Pass `fs:` instead and the shell
runs on **your** filesystem — that is the whole seam:

```js
import { memoryFs } from 'wasi-sh/fs';

const store = memoryFs({ '/app/main.sh': 'echo hi' });
await run({ command: 'sh /app/main.sh', fs: store, inline: true });
// the guest's writes are in `store`, readable from JS, reusable next run
```

A store is a path-addressed **synchronous** filesystem in ZenFS's
`FileSystem` shape — `statSync`, `readdirSync`, `createFileSync`, `mkdirSync`,
`rmdirSync`, `unlinkSync`, `renameSync`, `linkSync`, positional
`readSync`/`writeSync`, `touchSync`, `syncSync`. That shape is theirs on
purpose: the ecosystem's backends (OPFS and real user directories via
`@zenfs/dom`, a whole filesystem in a `SharedArrayBuffer`, copy-on-write
layers, remote trees) work here as-is, and `wasi-sh` still ships with zero
dependencies. Writing your own is fine too — `wasi-sh/fs/conformance` is the
suite that says whether it will hold up:

```js
import { checkConformance } from 'wasi-sh/fs/conformance';
const { failed } = checkConformance(() => myStore());
```

Five things worth knowing. **Creations name `uid`, `gid` and `mode`** — they
are required arguments there, and a store may record exactly what it is given,
so a shell that named none left a tree no second guest could read. A store is
**injected, never ambient**: no `fs` is the sealed sandbox, and a read-only
store is a read-only shell with nothing shell-side to bypass it. `/dev` belongs
to the shim, so mounting a real directory never writes device nodes into it —
and for the same reason a `files:` path under `/dev` is refused rather than
mounted somewhere invisible. What a store *does* receive is your `files:`, plus
`script:` if you use it, since that is mounted at `/main.sh`. And a store is a
live object, so in a browser it is registered inside the worker with
`serve({ fs })`, exactly like host builtins.

### Persistence: a project that survives a reload

Every backend that outlives a tab is asynchronous, and the contract is
synchronous, so the two meet through **hydrate-and-flush**: read the tree into
a cache before the guest starts, serve every call from it, pipeline the writes
back out. `@zenfs/dom` has both halves of that and neither is ours:
`IndexedDB` for a project that lives in the browser, `WebAccessFS` over any
`FileSystemDirectoryHandle` for one that lives in a folder the user picked.
**Reach for `IndexedDB` unless you specifically want that folder** — the
measurements below are lopsided enough to be a default rather than a
preference. `persistentFs()` is the seam either way:

```js
import { IndexedDB } from '@zenfs/dom';
import { indexedDbFlushPoint, persistentFs } from 'wasi-sh/fs';

const store = await persistentFs(
  await IndexedDB.create({ storeName: 'my-project' }),
  {
    onError: (err) => console.error('it did not save:', err),
    // Not optional for this backend. See below.
    commit: indexedDbFlushPoint({ database: 'my-project' }),
  },
);

await run({ inline: true, fs: store, command: 'echo hi > /a.txt' });
await store.flush();                       // and now it is on disk
```

**It is for a session that ends, and that is law 1 rather than a gap.** The
write-back is a promise chain, promises need the event loop, and a running
guest never gives it back — a live session is one synchronous `_start()` frame
that parks in `Atomics.wait`, so not one microtask runs between its first write
and its last. Measured: a shell parked on `/dev/hostreq` wrote a SQLite database
through a `WebAccessFS` and OPFS was still empty ten seconds later. So `run()`
persists and a long-lived `spawn()` does not. **`journalFs()` below is the one
that does.**

It does three things, each of which is silent when it is got wrong.
**Hydration is not automatic** — `create()` loads the index and not
the cache, and a store handed over between the two answers ENOENT for every
file that is really there, so the shell sees an empty project and the first
thing it writes shadows the real one. **A failed write-back is dropped** — the
queue is awaited with `.catch(() => {})`, so a quota that filled up is
invisible; `onError` is told as it happens and `flush()` raises it.
And **`syncSync()` cannot flush an async backend** — it is the shim's one flush
point, at every `proc_exit`, and nothing synchronous can await OPFS, so what it
reports is what has already failed. `flush()` is the awaitable half.

##### `commit`, and why `IndexedDB` needs one

Those three are the `Async` mixin's gaps. There is a fourth, for the backend
where the mixin is not there at all, and it is the worst of them because
everything above it goes on returning successfully.

`WebAccess.create()` returns an `Async(IndexFS)`, so its `sync()` awaits the
write-back chain and `flush()` means what it says. **`IndexedDB.create()`
returns a bare `StoreFS`**, whose `sync()` is `async sync() { }` — an empty
function — over a store whose own `sync()` is `Promise.resolve()`. Its writes
are neither queued on a promise this adapter can watch nor thrown from the call,
so without a `commit` its `flush()` resolves at once and promises nothing, and
`onError` never fires. Measured, the same writes through `flush()`:

| files | `IndexedDB`, no `commit` | `WebAccess` |
| --- | --- | --- |
| 300 | **0 ms** | 355 ms |
| 1200 | **0 ms** | 1686 ms |

`indexedDbFlushPoint({ database, store })` is the barrier, and it is built out
of one guarantee: transactions whose scopes overlap and of which one is
`readwrite` run **in the order they were created**, per database, across every
connection. So waiting for a `readonly` transaction created now is a way of
waiting for every write issued before it — which needs the two names the
embedder already chose and no ZenFS internal at all.

**There is no way to detect this from here**, which is why it is an argument
rather than a default: a bare `StoreFS` over an asynchronous store is
indistinguishable from one over a synchronous store, and the synchronous one is
`InMemory`, which is perfectly honest. Recorded as ZENFS.md finding 11.

Measured in Chromium against OPFS, 2,000 files / 15 MB: hydrate **~500 ms**,
a `writeSync` the guest sees as **0 ms**, its write-back **~13 ms** behind it.
The cache costs roughly 6× the project's size in heap. Sync access handles
(`createSyncAccessHandle`) are not used and are worker-only; they are the door
left open for a live SQLite file, not this.

#### Why the default is IndexedDB and not OPFS

**OPFS charges per file, and a project is thousands of them.** This is the
browser's price and not ZenFS's: in Firefox 153, creating one file in OPFS
costs ~2.5 ms and opening a sync access handle on it ~5.4 ms, against ~0.07 ms
to write three kilobytes into a handle that is already open — and 20 ms to
write six megabytes into one. Bytes are nearly free; handles are not, and a
file-per-file backend needs one of each per file.

The same 2,041-file, 6.9 MB project seeded through `persistentFs()`, written
with the operations a journal drain actually replays:

| backend | Firefox 153 | Chromium |
| --- | --- | --- |
| `WebAccess` (OPFS) | **34,799 ms** | 3,121 ms |
| `IndexedDB` | **194 ms** | 183 ms |

179× in Firefox and 17× in Chromium, and — the part that matters if you ship
to both — the 11× gap *between the browsers* becomes none at all. One
transaction carries the whole batch, so what the drain flushes in bulk is
committed in bulk. Verified byte-for-byte on both engines across a reopen,
including rewrite, truncate, rename and unlink, with no write-back reported
lost.

What OPFS buys for that price is the other handle: `WebAccessFS` takes any
`FileSystemDirectoryHandle`, so the same backend that reaches OPFS reaches a
**real directory on the user's disk** through `showDirectoryPicker()`. That is
worth every millisecond when it is what you want, and nothing when it is not.
Reading is not the deciding factor either way — the same tree walks back out of
OPFS in ~292 ms and out of a hydrated `IndexedDB` in ~838 ms, both of them
noise beside 34 seconds. Most of that 838 ms is one avoidable thing, noted here
because it is the shape of ZENFS.md's finding 5 in a second backend:
`IndexedDB.create()` warms its cache with `for (const id of await tx.keys())
await tx.get(id)` — one awaited round trip per record. Filling the same cache
from a single `getAll()` produces a byte-identical tree in ~403 ms in Firefox
and ~645 ms in Chromium. That is upstream's to fix; reaching into `store.cache`
to do it yourself buys half a second at the price of a private field.

### Persisting a session that never ends

A dev environment's shell sits on `/dev/hostreq` for the life of the tab, so
there is no exit for hydrate-and-flush to hang a drain on. `journalFs()` is the
store for that one: writes cannot *land* synchronously — no browser API reaches
a disk without awaiting — but they can **leave the guest's thread**
synchronously, and a second thread whose event loop is free lands them.

```js
// writer.worker.mjs — a worker of its own, NOT the one the shell runs in
import { IndexedDB } from '@zenfs/dom';
import { journalWriter } from 'wasi-sh/fs';

const writer = await journalWriter(
  await IndexedDB.create({ storeName: 'my-project' }),
  { onError: (err) => console.error('it did not save:', err) },
);
postMessage({ sab: writer.sab, snapshot: writer.snapshot });
```

The backend is the one from the section above, and the reason to care is
sharper here than it is there: a drain replays *every* write a long session
makes, so the per-file price is charged for the whole life of the tab and not
only at hydrate. A cold seed of 2,041 files is 194 ms of IndexedDB against 35
seconds of OPFS in Firefox — and a drain that takes 35 seconds is one a reload
can land in the middle of.

```js
// the shell's worker
import { serve } from 'wasi-sh/worker';
import { journalFs } from 'wasi-sh/fs';

// serve() is called SYNCHRONOUSLY, at the top of the module — it has to win the
// startup message, and one placed after a top-level await does not. So the wait
// for the writer's handover goes INSIDE fs(), which is awaited before the shell
// is built.
let handOver;
const handed = new Promise((resolve) => { handOver = resolve; });
self.addEventListener('message', (e) => {
  if (e.data?.type === 'store') handOver(journalFs(e.data.sab, e.data.snapshot));
});

serve({ fs: () => handed });
```

Reads come out of a synchronous cache seeded from `snapshot`; every mutation is
appended to a journal in the shared buffer, and the writer replays it into the
backing store. The writer parks in **`Atomics.waitAsync`**, not `Atomics.wait`
— the wait is a promise, so the backend's own promises still run. A writer that
blocked would reproduce law 1 one thread further along.

Three things follow from the shape, and each is the reason for a rule:

- **The writer is the only holder of the backend.** The guest's side never
  opens it. Two holders of one backing image is what corrupts a `@zenfs/core`
  `SingleBuffer`, and a cache that is authoritative for reads has nothing to
  race with. The cost, stated where it bites: a change another tab makes to the
  backend is invisible to a session already running.
- **`syncSync()` is a true flush point here** — the one thing `persistentFs`
  cannot offer. The writer advances the journal's tail only after its own flush
  resolved, so a drained journal means the bytes are on the disk rather than
  queued for it, and the shim's `proc_exit` finally tells the truth.
- **Worker-only, and it says so at construction.** Back-pressure and
  `syncSync()` both park in `Atomics.wait`, which the main thread refuses — the
  same rule the shell already lives under. It needs cross-origin isolation, as
  `spawn()` does.

A failure reaches the guest with its reason attached: the writer puts the
message in the shared buffer and the store raises it — as an `EIO` — at the
next call, once per failure. A writer that has stopped fails the next write
*before* the cache moves, because a write that succeeds into a cache nothing
drains looks exactly like one that saved.

**`snapshot`, when opening the backend is slower than reading the tree.** By
default the call above hydrates the backing store and then walks it, because a
snapshot has nowhere else to come from — and the guest waits for all of it. A
caller that can read the tree faster hands the result over instead; the writer
claims the journal and returns, and only the drain waits for the store:

```js
const root = await navigator.storage.getDirectory();
const writer = await journalWriter(
  WebAccess.create({ handle: root }),          // a promise — not awaited here
  { snapshot: await readTheTree(root) },       // what the store would produce
);
postMessage({ sab: writer.sab, snapshot: writer.snapshot });
```

Worth 1.3 s of a 1.9 s cold boot on a 6,504-file tree in OPFS, where reading it
in parallel costs 591 ms against 1,899 ms to hydrate a `WebAccessFS` and walk
it.

**This is an option and not an upgrade**, and it pays only when you can read the
tree faster than the backend hydrates. OPFS is such a backend: it holds real
files, so a parallel walk of the directory beats the index-then-data passes
`WebAccessFS` makes. `IndexedDB` is not — its records are ZenFS's own inodes
keyed by id, and there is nothing to read faster without decoding a format that
is not yours. Leave `snapshot` off there and let the default path hydrate and
walk (~838 ms on the 2,041-file tree above).

Three things it changes, all of them stated because they are the ways to get it
wrong:

- **The snapshot must be what the backing store would have produced** — the
  shape a default `journalWriter()` hands back, parents before children. It is
  what the guest's cache starts as and what every later write lands on top of.
- **An open that fails is no longer this call rejecting.** It arrives at
  `onError`, and at the guest's next write, like any other write-back failure.
- **`writer.store` throws until the store is open.** Await `writer.ready` for
  it; a property that is silently empty for the first second of a session is
  read as a store with nothing in it.

## Scope and drawbacks — read before depending on it

- **No processes, ever.** There is no fork/exec: no external programs, no
  backgrounding (`&`), no job control, and no exec-wrappers — `nohup`, `nice`,
  `time`, `timeout` cannot work. Job control is compiled out rather than merely
  unused, so `jobs`, `fg` and `bg` do not exist here at all. `kill` does — as
  the applet rather than the shell builtin, which is the more honest of the two
  anyway, since there are no job specs for `%1` to name. Networking (`wget`, `nc`), `/proc` tools
  (`ps`, `top`), and interactive full-screen tools (`vi`, `less`) are out of
  scope.
- **Shebangs are read, but there is still no exec.** `./bin/thing` works when
  its `#!` line names something this shell can already reach — a host builtin,
  an applet, a function — because ash reads the line itself and re-resolves the
  interpreter by basename; `env` is a shell builtin here for the same reason, so
  `#!/usr/bin/env php` and `env FOO=bar cmd` both work. Executable means *a
  readable file starting with `#!`*: there are no permission bits to consult.
  `#!/bin/sh` works too: a shell can now run inside a shell, capped at 8 deep.
- **Pipelines run sequentially**, each stage buffering fully before the next
  starts. Finite pipelines are fine; an infinite producer (`yes | head`)
  never terminates, and there's no backpressure.
- **Memory grows with use.** The coreutils were written to run in throwaway
  processes and leak a little per invocation (~2 KiB average). A `run()`
  one-shot doesn't care; a REPL session that executes tools continuously
  grows slowly and wasm memory is never returned — plan to
  `session.terminate()` and respawn long-lived sessions eventually.
- **A busy command can only be interrupted if it agrees to be.**
  `session.interrupt()` delivers a cooperative ^C (below). Applets and host
  builtins both stop; the *shell's* own loops do not, so `while :; do :; done`
  typed at the prompt still wants `terminate()`, and so does a command parked
  in a blocking read.
- **No symlinks**, and permission bits are carried but not enforced (`ln` and
  `chmod` are both absent, and `ls -l` shows placeholders for the mode).
  Timestamps are real, though: `stat` reports them and `[ a -nt b ]` orders two
  files by mtime — it is `ls -l` in this build that does not print them.
- A tool that fails or even calls `exit` only sets `$?` — the shell and
  session survive.
- **Host builtins are builtins**, so every limit above applies to them
  unchanged: `myTool &`, `(myTool)`, `exec myTool`, `timeout myTool` and
  `find -exec myTool` all fail exactly as they would for `echo`. And a handler
  runs **outside** the sandbox with your page's or process's full authority —
  `run()` is a hermetic script runner *until* you register one, after which the
  trust boundary is your handler. Validate `argv`.
- **A command name containing a slash is always "not found"** (`./x.sh`,
  `/bin/tool`) — there is nothing to exec, and host builtins are deliberately
  reachable by name only, never by path.
- **`$(...)` leaks `cd`, positional parameters, function definitions, aliases and
  traps** into the parent (variables and shell options *are* reverted).
  `x=$(cd /tmp)` leaves you in `/tmp`; `set -- a b` inside `$()` changes `$@`
  outside. These are silent — no error — so a script that relies on a forking
  shell's subshell isolation of any of them behaves differently here.

### Why plain WASI (and when to reach for WASIX instead)

wasi-sh targets **plain `wasm32-wasi`** on purpose. The alternative,
[WASIX](https://wasix.org/), extends WASI with real `fork`/`exec`, threads, and
sockets — so it runs an *unmodified* shell with genuine concurrent pipelines,
backgrounding, and networking, none of which the constraints above would limit.
We prototyped on WASIX first and moved off it: for this use case it was too slow
and heavy to start, and the runtime story is narrower. tuish — the TUI framework
this exists to host — barely uses pipes and never forks, so the fork-free model
costs it nothing while keeping startup and footprint small.

The rule of thumb: if your scripts live within the constraints above (no `&`, no
subshell/process substitution, no external programs, sequential pipelines), use
wasi-sh — it is smaller and faster. If you need real process semantics, use a
WASIX runtime instead; wasi-sh will not grow them.

Deeper technical detail on all of this: [ARCHITECTURE.md](ARCHITECTURE.md).

## Terminals: bring your own

wasi-sh has **no terminal dependency** and never will. A `Session` is a byte
duplex; a terminal is anything that feeds `session.write()` and renders
`session.onOutput()` bytes. Geometry travels as plain env
(`COLUMNS`/`LINES`), set by whoever owns the terminal.

Wiring [xterm.js](https://xtermjs.org) is two lines:

```js
const session = await spawn({ tty: true });      // the shell edits its own line
term.onData((d) => session.write(d));            // keyboard → shell
session.onOutput((b) => term.write(b));          // shell → screen
```

### `tty: true`, and who edits the line

Those really are the only two lines, because **`tty: true` gives the shell its
own line editor**: a prompt, echo, history, arrow keys, `^C`, and **tab
completion** over applets, builtins, shell functions, aliases, `$VAR`s, your
host builtins and the filesystem. It is busybox's `libbb/lineedit.c`, running
in the guest — nothing to write and nothing to keep in sync.

What the option actually does is make `isatty(0)` and `isatty(1)` true. That is
the only thing ash checks before setting `iflag` and calling
`read_line_input()`, so without it the editor is compiled in and never runs —
which is what this build did until now.

**It is opt-in, and the reason is that a line cannot be edited twice.** A page
that keeps its own editor — accumulating keys, echoing them itself, sending the
line on Enter — will print every line twice with this on. Pick one:

| | `tty: true` | default |
|---|---|---|
| who echoes | the guest | you |
| who draws the prompt | the guest (`PS1`) | you |
| history, arrows, Tab | free | yours to build |
| what you send | every byte, as typed | a finished line |
| `^C` | send the byte **and** `session.interrupt()` | `interrupt()` only while a command runs |

`run()` is never a tty: a fixed stdin is not a terminal.

One caveat if you set `PS1`: this build has `FEATURE_EDITING_FANCY_PROMPT`
off, so the editor measures the prompt with `strlen()`. A colour escape in
`PS1` counts as visible width and puts the cursor in the wrong column — keep it
plain text.

### Completion for a terminal that edits its own lines

Keeping your own line editor is a legitimate choice, and sometimes the only one
— a guest parked at a prompt is parked on **stdin**, so a session that also has
to answer something else (a request channel, a dev server) cannot host one.

`compgen` is the same completion engine, callable as a command:

```
compgen -c WORD    command names: applets, builtins, functions, aliases,
                   host builtins, and a PATH scan
compgen -f WORD    files and directories
compgen -d WORD    directories only
```

One candidate per line on stdout, status 1 when there are none. Two things to
know, both inherited from the editor so that the two agree:

- candidates are **basenames, not paths** — `compgen -f src/te` answers
  `terminal.mjs`, and you re-attach `src/`;
- a **directory carries a trailing slash**, a file does not (so completing a
  directory should not append a space).

Use `--` when the word may start with a dash: `compgen -f -- -l`.

One knob matters: the guest has no tty line discipline (no ONLCR), so its
output is LF-only — set `convertEol: true` so the terminal supplies the
carriage returns. The exception is a raw-drawing TUI that positions with
explicit `\r` and cursor addressing (tuish does): that wants `convertEol:
false` so its bytes pass through untouched.

**Resize** is a third line. wasm has no SIGWINCH and no PTY, so a *running* guest
can't otherwise learn the terminal changed. `session.resize()` bridges that over
the stdin ring: it stores the live size (readable via `stty size` /
`TIOCGWINSZ`) and synthesizes a **SIGWINCH**, so a shell with `trap ... WINCH`
(tuish's whole resize path) relayouts in place — no re-spawn.

```js
term.onResize(({ cols, rows }) => session.resize(cols, rows));   // resize → shell
```

For an interactive session, geometry lives in that ioctl, not the environment:
`spawn()` uses the initial `COLUMNS`/`LINES` to seed the size and then does **not**
export them to the guest (busybox `stty size` would prefer the frozen env vars
over the live ioctl). So pass the starting size as `env: { COLUMNS, LINES }` as
usual — it becomes the first `stty size` — and drive changes with
`session.resize()`. A guest that doesn't trap WINCH just ignores the signal; the
fresh size is still there for the next `stty size`.

**Interrupt** is the fourth. wasm has no signals, so a command that will not
stop holds the worker and `terminate()` — which takes the filesystem and every
warm instance with it — is otherwise the only way out. `session.interrupt()`
raises a count in the same ring and wakes the guest; work that polls it stops
and reports 130.

```js
term.attachCustomKeyEventHandler((e) => {          // ^C → interrupt
  if (e.type === 'keydown' && e.ctrlKey && e.key === 'c' && commandRunning) {
    session.interrupt();
    return false;
  }
  return true;
});
```

Note the `commandRunning` guard. At the prompt, `^C` is a byte the shell wants
for its own line editing, so a terminal that swallows `0x03` unconditionally
takes it away from the guest. And *cooperative* is the whole contract: it
cancels what chose to look, and the count says what "look" means — a ^C posted
while nothing is running cancels nothing, rather than waiting to cancel the next
thing you type.

**Under `tty: true` the guard is unnecessary, and you cannot write it anyway** —
the page no longer knows whether a command is running. Send the byte *and* the
interrupt, unconditionally: the byte is what the guest's editor uses to abandon
a half-typed line, and the interrupt cancels nothing when nothing is running,
which is exactly the sentence above being useful.

```js
term.onData((d) => {                                // tty: true
  session.write(d);
  if (d.includes('\x03')) session.interrupt();
});
```

**Applets look on your behalf.** A runaway `seq`, `cat`, `grep`, `sort`, `awk`
or `sed` stops at its next read, write or loop turn and the shell reads 130 in
`$?`, with its filesystem and every warm instance intact. **Host builtins look
for themselves** — `ctx.interrupted()`, below. What is *not* reached is the
shell itself: a loop written in shell runs no applet, and a command parked in a
blocking read has no bytes to wake it. `terminate()` is still the answer for
those two.

Any other web terminal integrates the same way — see
`examples/dumb-terminal.html` for a complete session wired to a bare `<pre>`
and `<input>` with no terminal library at all, and `examples/repl.html` for
an xterm-based REPL on `tty: true` (xterm from a CDN; not a dependency) — the
whole of its terminal integration is the three lines above, because the shell
does the editing.

## Host builtins: your own commands

The shell resolves a name against its functions, its builtins and the applet
table — and then, if you registered one, a **host builtin**: a JS function that
takes argv and returns an exit status.

```js
import { run } from 'wasi-sh';

const { stdout } = await run({
  inline: true,                       // node default; see below for browsers
  command: 'json .name < /pkg.json | tr a-z A-Z',
  files: { '/pkg.json': '{"name":"wasi-sh"}' },
  builtins: {
    json(ctx) {
      const doc = JSON.parse(new TextDecoder().decode(ctx.stdin()));
      ctx.stdout(`${doc[ctx.argv[1].slice(1)]}\n`);
      return 0;
    },
  },
});
// stdout === 'WASI-SH\n'
```

They are builtins, not processes — in-process, argv in, status out, no address
space and nothing to wait for, exactly like a busybox applet. What you get from
that is composition: by the time a builtin is dispatched the shell has already
installed its redirections, so **`ctx.stdout` goes wherever fd 1 currently
points** — a pipeline stage, a `> file`, a `$(...)` capture — with no work on
your part.

`ctx` is `{ argv, env, cwd, stdin(max), stdout(bytes), stderr(bytes), fs,
interrupted() }`. `env` is the shell's live environment, exports and `VAR=x cmd`
prefixes included; `cwd` comes from the guest itself, so relative paths in
`ctx.fs` resolve the way the script expects. `type name` reports `name is a host
builtin` and `command -v name` prints it, so scripts can probe.

**A long-running builtin should poll `ctx.interrupted()`.** It answers true once
`session.interrupt()` has been called since *this* command started — an earlier
^C, typed while nothing was running, is not inherited. It is the only way out of
a busy handler: the handler runs on the guest's own stack, so nothing can unwind
it from outside, and the safe points are the ones it picks itself.

```js
mytool(ctx) {
  for (const item of huge) {
    if (ctx.interrupted()) return 130;   // 128 + SIGINT, what `$?` should say
    work(item);
  }
  return 0;
}
```

It does not end a blocking `ctx.stdin()`: the wait wakes, but no bytes appeared,
so the read parks again. A builtin that wants to be interruptible while waiting
for input has to read with its own timeout and check between attempts.

**Handlers must be synchronous.** The guest is a synchronous wasm stack frame
below the call — there is nothing to await into. Returning a promise is
reported as an error rather than silently succeeding at exit 0. Throwing is
contained: the message goes to stderr and the command fails, but the shell
lives.

Precedence is functions → shell builtins → applets → **host builtins** → the
path search. Applets win, so registering `grep` does nothing: what the shipped
toolbox means cannot be changed out from under a script.

**They complete like any other command.** A map's keys are the list, so Tab at a
`tty: true` prompt and `compgen -c` both offer your names with no extra wiring.

If you registered a *provider* instead of a map — the extension point for a
dynamic namespace, an object with its own `lookup(name)` and `run(ctx)` — add an
optional `names()` to be completable:

```js
serve({ builtins: {
  lookup: (name) => index.has(name),
  run: (ctx) => index.get(ctx.argv[0])(ctx),
  names: () => [...index.keys()],     // optional: what Tab and compgen offer
} });
```

It is optional because listing promises more than looking up, and a lazy index
may genuinely be unable to. Leave it out and your commands still resolve and
still run — completion just never mentions them. It is read once per session,
on the first completion.

### In a browser: register them in the worker

Handlers are functions, and `postMessage` structured-clones its payload — so
they cannot be handed to a worker from the page. Write a worker module that
registers them, and point `run()` (or `spawn()`) at it:

```js
// my-worker.mjs
import { serve } from 'wasi-sh/worker';

serve({
  async builtins() {              // awaited once, BEFORE the shell starts
    const engine = await bootSomethingExpensive();
    return { mytool: (ctx) => { ctx.stdout(engine.run(ctx.argv)); return 0; } };
  },
});
```

```js
// the page
await run({ command: 'mytool | wc -l', workerUrl: new URL('./my-worker.mjs', import.meta.url) });
```

That split is the point: the *setup* is async and happens once, so every
*invocation* can be synchronous. It is what lets a builtin be backed by a whole
second wasm module — an interpreter, say — booted up front and called warm.

Call `serve()` **synchronously**, at the top of the module, before any
top-level `await`. A startup message that arrives while the module is suspended
is delivered to no one, and the shell would quietly run without your builtins;
`serve()` detects a late call and fails loudly instead.

**The worker's other messages are yours.** Only a message carrying wasm is the
startup message; anything else is left for a listener of your own. That is what
lets a factory wait on something the page hands over — a store is a live object,
so what actually crosses is the `SharedArrayBuffer` behind it:

```js
// my-worker.mjs
import { serve } from 'wasi-sh/worker';

let handOver;
const handed = new Promise((res) => { handOver = res; });
self.addEventListener('message', (e) => { if (e.data.type === 'store') handOver(e.data.sab); });

serve({ async fs() { return storeOver(await handed); } });
```

```js
// the page — post first, then spawn; both messages queue in order
const worker = new Worker(new URL('./my-worker.mjs', import.meta.url), { type: 'module' });
worker.postMessage({ type: 'store', sab });
const session = await spawn({ worker });
```

One worker hosts exactly one shell: a second `run()`/`spawn()` over the same
`worker` is refused rather than started beside the first.

Working example: [`examples/host-builtins.html`](examples/host-builtins.html)
and its [worker](examples/host-builtins.worker.mjs).

## The host port: reaching outside the sandbox

A host builtin extends the shell's *command* namespace. The **host port**
extends what a script can reach *outside* it — the clipboard, the page around
it, whatever you decide to hand over. One capability object, one virtual
device, verbs instead of an option per feature:

```js
let clipboard = 'whatever the page last staged';

const { stdout } = await run({
  inline: true,
  script: "echo clipboard.read > /dev/host\n"
        + 'echo "pasted: $(cat /dev/host)"\n',
  host: {
    'clipboard.read': () => clipboard,
    'clipboard.write': (payload) => { clipboard = new TextDecoder().decode(payload); },
  },
});
// stdout === 'pasted: whatever the page last staged\n'
```

A verb is **synchronous**, so an async browser API is staged by the page
rather than awaited inside one — read `navigator.clipboard.readText()` when the
user grants it and keep the value where the verb can reach it.

A request is a **line** written to `/dev/host` — a verb, optionally a space and
a payload — and the answer is read back from the same name. A verb answers with
a `Uint8Array`, a string, or nothing; the response is raw bytes, so the verb
decides its own format.

Each **open** is one exchange: a redirection's writes all belong together and
their answers concatenate, however many `write(2)`s they arrive as, while the
next command starts clean — so `write; read` means the same thing whatever ran
before it. A write that fails leaves nothing to read at all.

**Capabilities are injected, never ambient.** With no `host` the device is
still there and every open is `EPERM`, so a script can tell *"this session did
not grant it"* from *"no such thing"*:

```sh
if ! cat /dev/host >/dev/null 2>&1; then echo "no port here"; fi
```

Hand over an object implementing only `clipboard.*` and that is the entire
surface a script can reach. There is nothing shell-side to widen it.

The synchronous rule is the same one builtins have, and for the same reason:
the guest is a wasm stack frame below the call. That is not the restriction it
sounds like — the port is *outbound* only, and outbound synchronous is the
direction that needs no shared memory, no `Atomics.wait` and no cross-origin
isolation. Async setup goes in the factory form, awaited once before the shell
starts.

A verb that throws, returns a promise, or answers with something that is not
bytes fails that one write and says why on stderr; the shell lives. The failure
reaches `$?` — `echo verb > /dev/host || handle_it` works — and a failed
request leaves nothing to read, so a script can test either.

In a browser, register the port in the worker exactly as with builtins — a
capability object cannot be structured-cloned either:

```js
serve({ async host() {
  const db = await openDatabase();
  return { 'db.get': (payload) => db.get(new TextDecoder().decode(payload)) };
} });
```

This is also the only way an interactive `spawn()` session gets one.

### The other direction: the host asking the guest

Everything above is the guest calling out. The port also runs **inbound** — the
host handing a request to a script that is already running — which is what
turns the awkward case idiomatic: **a dev server is a shell loop.**

```sh
while read -r req <&3; do
    printf 'respond %s\n' "$(handle "$req")" > /dev/host
done 3< /dev/hostreq
```

```js
const session = await spawn({ script, requestBufferSize: 65536 });
session.post('GET /index.php');     // reaches the loop above, parked, in <1ms
session.endRequests();              // EOF: the loop ends
```

This is the one direction `postMessage` cannot go. A live session is a single
synchronous `_start()` frame, so the worker's event loop never turns while the
shell is running: a message posted into it is not slow, it is *not delivered*.
A request travels through shared memory the guest reads at its blocking point
instead — the same mechanism a terminal resize uses.

A request is a **line**, the framing the outbound half already uses. The reply
is an ordinary outbound verb, because a request the guest is still handling has
nothing to return yet.

The two things the loop has to be told, it is told in the shell's own terms:

| | what it means |
|---|---|
| `EPERM` at open | this session can **never** receive a request — the loop refuses to start |
| EOF at read | no more are coming — `read` fails and the loop ends |

There is no third answer, deliberately. Every other way a request can fail — a
newline inside it, one too big for the ring — is refused at `post()`, where the
host still holds it and can do something about it. A guest parked on a request
has no write to fail and no `$?` to reach, so an error it could only learn by
reading is one it cannot act on.

`requestBufferSize` **is** the grant: without it `/dev/hostreq` is `EPERM`, like
the outbound half with no `host`. The size is also the cap on unread requests —
`post()` throws `RingOverflowError` when the guest is not consuming, which is
the host's problem to size.

For `run()`, where nothing can arrive *during* the run because the guest holds
the thread for its whole life, the same channel is staged up front:

```js
await run({ inline: true, script, requests: ['GET /a.php', 'GET /b.php'] });
```

**A blocking verb freezes that guest for its duration** — inbound or outbound,
the guest is a wasm frame below the call. Familiar from any blocking read, and
worth knowing before a verb does something slow.

Working example, both directions:
[`examples/host-port.html`](examples/host-port.html) and its
[worker](examples/host-port.worker.mjs) — a dev server that is a shell loop,
driven from the page.

## API

| import | what |
|---|---|
| `wasi-sh` | `run`, `spawn`, `Session`, `fetchTree`, `WasiShim`, `WasiExit`, ring |
| `wasi-sh/node` | `run`, `runScript`, `compileWasm`, `readTree` (fs sugar; node-only) |
| `wasi-sh/shim` | `WasiShim`, `WasiExit` — the WASI machine, pluggable I/O |
| `wasi-sh/ring` | `createRing`, `RingWriter`, `RingReader`, `frameRequest` — the SAB rings |
| `wasi-sh/fs` | `memoryFs`, `persistentFs`, `indexedDbFlushPoint`, `journalFs`/`journalWriter` and the `fs` contract — the filesystem, pluggable |
| `wasi-sh/fs/conformance` | `conformanceCases`, `checkConformance` — prove your own store |
| `wasi-sh/files` | `fetchTree` — mount remote file trees |
| `wasi-sh/worker` | the Worker entry (reference by URL); `serve` to register builtins, a store, a host port |
| `wasi-sh/busybox.wasm` | the shell binary |

**Shared options** (`run` and `spawn`): `wasm` (URL \| string \| `Response` \|
bytes \| `WebAssembly.Module`; defaults to the bundled binary), `args` (full
argv — busybox is a multicall binary, argv[0] is `busybox`), `command`
(sugar for `sh -c`), `script` (mounted at `/main.sh`), `files`
(`{ '/path': string | Uint8Array }`), `env` (merged over
`PATH=/ HOME=/ TERM=xterm-256color LANG=C.UTF-8`).

`run` also takes `fs` (a store) and `host` (a capability port). Both need
`inline: true`, since a live object cannot be structured-cloned into a Worker —
off-thread runs and `spawn` use `serve({ fs, host })` in a worker module
instead, and passing either to a stock worker throws and says so. `run` takes
`requests` (the inbound channel, staged up front); `spawn` takes
`requestBufferSize` and feeds the same channel live with `session.post()`.

**`fetchTree`** assembles `files` from URLs:

```js
const files = await fetchTree({
  manifestUrl: './manifest.json',      // JSON array of relative paths (or paths: [...])
  baseUrl: './tree/',
  mount: '/app',
  filter: (rel) => rel.endsWith('.sh'),
  transform: (path, text) => text,     // adapt sources to the sandbox
});
```

**Escape hatches**: `worker` / `workerUrl` (bring your own Worker for
bundler or CSP constraints), `stdinBufferSize` (spawn's ring, default 64 KiB),
`requestBufferSize` (spawn's inbound host-request ring; absent means no
channel), and `WasiShim` itself for full control over stdin transport and
execution context.

## Deployment: cross-origin isolation

Only `spawn()` needs this. `SharedArrayBuffer` requires the page to be
cross-origin isolated, i.e. served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- Local dev: `npm run serve` sends the headers.
- Hosts where you control headers (Netlify, Vercel, nginx…): add the two
  headers. **This is the reliable path.**
- Hosts where you can't (e.g. GitHub Pages): a service-worker shim such as
  [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) exists,
  but in our testing it is **unreliable in current Chrome** (isolation
  sometimes never engages after the shim's reload). Treat it as best-effort;
  prefer a host that lets you set headers.
- `run()`-only pages need none of this.

`spawn()` fails fast with a descriptive error when isolation is missing.

## node

Everything works headless. `run()` executes inline; `wasi-sh/node` adds
filesystem sugar:

```js
import { runScript, readTree, compileWasm } from 'wasi-sh/node';

const wasm = await compileWasm();                  // compile once
const files = await readTree('./scripts', { mount: '/app' });
const r = await runScript('. /app/lib.sh && main', { wasm, files });
```

Interactive semantics are testable headless too — drive a
`worker_threads` worker with `RingWriter`/`RingReader` (see
`test/interactive.test.mjs`).

## Building the wasm from source

`dist/busybox.wasm` is busybox 1.38.0 (`ash` + the applet set above), built
by `build/build.sh` — pinned tarball + SHA-256, the fork-free patch, an
ash-plus-applets config, and a `wasm32-wasi` toolchain (see the script and
[ARCHITECTURE.md](ARCHITECTURE.md) for the flag rationale).

It ships in the npm package but is **not committed to git**, so a fresh
clone has to build before it can test:

```sh
pip install ziglang==0.15.1      # or install zig itself
npm run build:wasm
npm test
```

`build:wasm` refuses to install a binary that fails its smoke test. After a
rebuild, run `npm test` and the downstream consumer checks before trusting
it.

The shipped module is stripped of DWARF — that was two thirds of its size —
but keeps its `name` section, so wasm stack traces still symbolicate. Pass
`build/build.sh --debug` if you need the debug info while working on the
shim.

The toolchain has to be zig: busybox's `libbb.h` needs `netdb.h`, `paths.h`,
`pwd.h`, `grp.h`, `sys/wait.h` and `termios.h`, and zig supplies all six from
its `generic-musl` include tree, which the wasi-sdk sysroot does not ship.

## Licensing

The JavaScript in this package is **ISC**. `dist/busybox.wasm` is compiled
from [BusyBox](https://busybox.net), which is **GPL-2.0** — the binary
remains GPL-2.0; `build/` contains the complete corresponding source recipe
(config, patch, build script) and `build/COPYING` is the license text. If you
redistribute the wasm, GPL-2.0 terms apply to it.
