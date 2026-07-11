# wasi-sh

Run **pure shell scripts in the browser** (and node) — busybox `ash` compiled
to plain `wasm32-wasi`, fork-free. Command substitution, pipes of builtins,
subshell isolation, heredocs, `read -t` timing: a real POSIX-flavored shell,
in-process, no server.

```js
import { run } from 'wasi-sh';

const { stdout, exitCode } = await run({
  command: 'for i in 1 2 3; do echo "line $i"; done',
});
// stdout === 'line 1\nline 2\nline 3\n'
```

That works on **any static host with no special headers** — non-interactive
execution never blocks on the user, so it needs no `SharedArrayBuffer`.

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
session.end();        // stdin EOF
session.terminate();  // hard kill (exited resolves 137, kill -9 style)
await session.exited; // exit code — always settles, even after terminate()
```

`spawn()` parks the shell in a Worker on a `SharedArrayBuffer` stdin ring
(`Atomics.wait`), so the guest's blocking `read` and timed `read -t` behave
like a real terminal's. That is the one thing that **requires cross-origin
isolation** — see [Deployment](#deployment-cross-origin-isolation).

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

Any other web terminal integrates the same way — see
`examples/dumb-terminal.html` for a complete session wired to a bare `<pre>`
and `<input>` with no terminal library at all, and `examples/repl.html` for
an xterm-based REPL (xterm from a CDN; not a dependency).

## Scope — what this is and is not

The guest is **busybox `ash` only, builtins only**:

- **No external programs.** There is no `exec`, no processes, no other
  applets — `ls`, `cat`, `stty` etc. are "not found". Shell builtins
  (`echo`, `printf`, `read`, `test`, `[`, arithmetic, globs, functions)
  are the toolbox.
- **Fork-free `$(...)` and pipes.** `fork()` is stubbed to `ENOSYS`; a small
  ash patch runs command substitution and builtin pipelines in-process
  through host-backed in-memory pipes. Pipe stages run sequentially through
  unbounded buffers (fine for finite pipelines; an infinite producer like
  `yes | head` would not terminate). Subshell isolation covers variables and
  shell options; functions/aliases/traps/cwd isolation is incomplete.
- **In-memory filesystem.** Mounted `files` are readable and writable
  (copy-on-write — your mounted buffers are never mutated), and scripts can
  create files where a parent directory exists (`/tmp` is always there).
  Everything vanishes when the run or session ends. This runs *scripts*,
  not systems.
- No job control, no signals, no TTY ioctls.

## API

| import | what |
|---|---|
| `wasi-sh` | `run`, `spawn`, `Session`, `fetchTree`, `WasiShim`, `WasiExit`, ring |
| `wasi-sh/node` | `run`, `runScript`, `compileWasm`, `readTree` (fs sugar; node-only) |
| `wasi-sh/shim` | `WasiShim`, `WasiExit` — the WASI machine, pluggable I/O |
| `wasi-sh/ring` | `createStdinRing`, `RingWriter`, `RingReader` — the SAB stdin ring |
| `wasi-sh/files` | `fetchTree` — mount remote file trees |
| `wasi-sh/worker` | the Worker entry (referenced by URL, not imported) |
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
  headers.
- Hosts where you can't (e.g. GitHub Pages): a service-worker shim such as
  [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) can
  enable isolation client-side. Whether to adopt one is your deployment
  choice — wasi-sh doesn't bundle it.
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

`dist/busybox.wasm` is busybox 1.38.0 `ash`, built by `build/build.sh`
(pinned tarball + SHA-256, the fork-free ash patch, an ash-only config, and
a `wasm32-wasi` toolchain — zig or wasi-sdk; see the script for the flag
rationale). `npm run build:wasm` rebuilds it and refuses to install a binary
that fails its smoke test.

The currently shipped binary is the one proven end-to-end by the original
research port (this package's test suite runs against it); a from-source
rebuild should additionally pass `npm test` and the downstream consumer
checks before being trusted.

## Licensing

The JavaScript in this package is **ISC**. `dist/busybox.wasm` is compiled
from [BusyBox](https://busybox.net), which is **GPL-2.0** — the binary
remains GPL-2.0, and `build/` contains the complete corresponding source
recipe (config, patches, build script). If you redistribute the wasm,
GPL-2.0 terms apply to it.

## How it works

Three small pieces:

1. **A WASI preview1 shim** (`wasi-sh/shim`, ~200 lines): writable in-memory
   FS (copy-on-write over your mounts), in-memory pipes behind busybox's
   `__host_pipe`/`__host_dup` imports (that's what makes fork-free `$(...)`
   and pipes possible), and a pluggable stdin.
2. **A Worker** that runs the wasm off the main thread. For `spawn()` it
   parks on the stdin ring via `Atomics.wait` — blocking reads cost nothing;
   for `run()` stdin is a fixed buffer and no SAB is involved.
3. **A SAB ring** (`wasi-sh/ring`): monotonic head/tail counters, an EOF
   flag, overflow detection, and sequence-word wakeups.
