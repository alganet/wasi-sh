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
  globs, functions)

You can add to that list: see [Host builtins](#host-builtins-your-own-commands)
for registering your own commands, written in JS.

`command -v NAME` / `type NAME` tell you what exists. `find -exec` and
`xargs` work for simple children like `echo`. The filesystem you mount via
`files:` is **writable inside the sandbox** (copy-on-write — your buffers are
never touched; everything vanishes when the run ends), so
`grep -r`, `sed -i`, redirects, and `/tmp` scratch files all behave normally.

## Scope and drawbacks — read before depending on it

- **No processes, ever.** There is no fork/exec: no external programs, no
  backgrounding (`&`), no job control, and no exec-wrappers — `env CMD`,
  `nohup`, `nice`, `time`, `timeout` cannot work. Networking (`wget`, `nc`),
  `/proc` tools (`ps`, `top`), and interactive full-screen tools (`vi`,
  `less`) are out of scope.
- **Pipelines run sequentially**, each stage buffering fully before the next
  starts. Finite pipelines are fine; an infinite producer (`yes | head`)
  never terminates, and there's no backpressure.
- **Memory grows with use.** The coreutils were written to run in throwaway
  processes and leak a little per invocation (~2 KiB average). A `run()`
  one-shot doesn't care; a REPL session that executes tools continuously
  grows slowly and wasm memory is never returned — plan to
  `session.terminate()` and respawn long-lived sessions eventually.
- **A busy command can't be interrupted.** There is no ^C delivery into a
  running tool; a long `awk` holds the worker until it finishes
  (`terminate()` still kills the session from outside).
- **No symlinks, permissions, or timestamps** in the sandbox FS (`ln` is
  deliberately absent; `ls -l` shows placeholders).
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
term.onData((d) => session.write(d));            // keyboard → shell
session.onOutput((b) => term.write(b));          // shell → screen
```

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

Any other web terminal integrates the same way — see
`examples/dumb-terminal.html` for a complete session wired to a bare `<pre>`
and `<input>` with no terminal library at all, and `examples/repl.html` for
an xterm-based REPL (xterm from a CDN; not a dependency).

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

`ctx` is `{ argv, env, cwd, stdin(max), stdout(bytes), stderr(bytes), fs }`.
`env` is the shell's live environment, exports and `VAR=x cmd` prefixes
included; `cwd` comes from the guest itself, so relative paths in `ctx.fs`
resolve the way the script expects. `type name` reports `name is a host
builtin` and `command -v name` prints it, so scripts can probe.

**Handlers must be synchronous.** The guest is a synchronous wasm stack frame
below the call — there is nothing to await into. Returning a promise is
reported as an error rather than silently succeeding at exit 0. Throwing is
contained: the message goes to stderr and the command fails, but the shell
lives.

Precedence is functions → shell builtins → applets → **host builtins** → the
path search. Applets win, so registering `grep` does nothing: what the shipped
toolbox means cannot be changed out from under a script.

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

Working example: [`examples/host-builtins.html`](examples/host-builtins.html)
and its [worker](examples/host-builtins.worker.mjs).

## API

| import | what |
|---|---|
| `wasi-sh` | `run`, `spawn`, `Session`, `fetchTree`, `WasiShim`, `WasiExit`, ring |
| `wasi-sh/node` | `run`, `runScript`, `compileWasm`, `readTree` (fs sugar; node-only) |
| `wasi-sh/shim` | `WasiShim`, `WasiExit` — the WASI machine, pluggable I/O |
| `wasi-sh/ring` | `createStdinRing`, `RingWriter`, `RingReader` — the SAB stdin ring |
| `wasi-sh/files` | `fetchTree` — mount remote file trees |
| `wasi-sh/worker` | the Worker entry (reference by URL); `serve` to register host builtins |
| `wasi-sh/busybox.wasm` | the shell binary |

**Shared options** (`run` and `spawn`): `wasm` (URL \| string \| `Response` \|
bytes \| `WebAssembly.Module`; defaults to the bundled binary), `args` (full
argv — busybox is a multicall binary, argv[0] is `busybox`), `command`
(sugar for `sh -c`), `script` (mounted at `/main.sh`), `files`
(`{ '/path': string | Uint8Array }`), `env` (merged over
`PATH=/ HOME=/ TERM=xterm-256color LANG=C.UTF-8`).

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
and `WasiShim` itself for full control over stdin transport and execution
context.

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

The toolchain has to be zig: busybox's `libbb.h` needs `netdb.h`, `paths.h`,
`pwd.h`, `grp.h`, `sys/wait.h` and `termios.h`, and zig supplies all six from
its `generic-musl` include tree, which the wasi-sdk sysroot does not ship.

## Licensing

The JavaScript in this package is **ISC**. `dist/busybox.wasm` is compiled
from [BusyBox](https://busybox.net), which is **GPL-2.0** — the binary
remains GPL-2.0; `build/` contains the complete corresponding source recipe
(config, patch, build script) and `build/COPYING` is the license text. If you
redistribute the wasm, GPL-2.0 terms apply to it.
