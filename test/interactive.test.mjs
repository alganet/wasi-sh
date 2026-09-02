// Interactive Session semantics, headless: a node worker_threads twin of
// src/worker.mjs runs the shell parked on the real SAB ring while the main
// thread drives it through RingWriter — the same Atomics.wait machinery the
// browser uses, no DOM, no terminal. (This file is also one of the three
// in-tree consumers proving the byte-duplex contract needs no terminal.)
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createStdinRing, RingWriter } from '../src/ring.mjs';
import { compileWasm } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

// The node twin of src/worker.mjs: same shim + RingReader wiring, with
// parentPort standing in for postMessage.
const TWIN = `
  import { parentPort, workerData } from 'node:worker_threads';
  const { WasiShim, WasiExit } = await import(workerData.shimUrl);
  const { RingReader } = await import(workerData.ringUrl);
  const { hostBuiltins } = await import(workerData.optionsUrl);
  const { module, files, args, env, sab, tty } = workerData;
  const dec = new TextDecoder();
  let out = '';
  const emit = (b) => { const s = dec.decode(b); out += s; parentPort.postMessage({ type: 'out', text: s }); };
  const shim = new WasiShim({
    args, env, files,
    stdout: emit,
    stderr: emit,
    input: new RingReader(sab).toInput(),
    // A tty is what gives the guest its OWN line editor; see the tab-completion
    // block at the end of this file.
    tty,
    // Constructed HERE, not passed in: a function does not survive
    // structured clone, so a builtin can only be registered inside the worker.
    builtins: hostBuiltins({ mytool: (ctx) => { ctx.stdout('mytool ran\\n'); return 0; } }),
  });
  const instance = await WebAssembly.instantiate(module, shim.imports());
  shim.bindMemory(instance.exports.memory);
  let code = 0;
  try { instance.exports._start(); }
  catch (e) { if (e instanceof WasiExit) code = e.code; else throw e; }
  parentPort.postMessage({ type: 'exit', code, out });
`;

// `script` is the shell script to run. Pass null for tty:true instead: a
// PROMPT is the thing under test there, and a shell given a script file to run
// never shows one.
function spawnTwin(script, { env = {}, tty = false, files = {} } = {}) {
  const sab = createStdinRing();
  const writer = new RingWriter(sab);
  const worker = new Worker(TWIN, {
    eval: true,
    workerData: {
      module: wasm,
      files: script == null ? files : { '/t.sh': script, ...files },
      args: script == null ? ['busybox', 'sh'] : ['busybox', 'sh', '/t.sh'],
      env: { PATH: '/', LC_ALL: 'C', ...env },
      sab,
      tty,
      shimUrl: new URL('../src/shim.mjs', import.meta.url).href,
      ringUrl: new URL('../src/ring.mjs', import.meta.url).href,
      optionsUrl: new URL('../src/options.mjs', import.meta.url).href,
    },
  });
  // `live()` is output SO FAR: the winch tests below assert on what the guest
  // has printed while it is still parked, which an exit-time snapshot cannot say.
  let seen = '';
  const exited = new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.type === 'exit') { resolve(m); worker.terminate(); }
      else if (m.type === 'out') seen += m.text;
    });
    worker.on('error', reject);
  });
  return { writer, exited, live: () => seen };
}

const enc = new TextEncoder();

test('read -t honors its timeout (the ppoll/poll_oneoff chain end-to-end)', async () => {
  const t0 = Date.now();
  const { exited } = spawnTwin('read -t 0.2 x; echo "to rc=$?"');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /to rc=1/, 'read -t with no input fails past the timeout');
  assert.ok(elapsed >= 150, `waited the timeout (${elapsed}ms)`);
  assert.ok(elapsed < 1500, `did not hang (${elapsed}ms)`);
});

test('read -t honors timeouts over one second (whole seconds must not drop)', async () => {
  // Regression for two compounding bugs: the guest once truncated the
  // timeout to (ms % 1000) — `read -t 2` timed out instantly — and the host
  // shim waited the remaining timeout twice. 1.2s catches both: seconds
  // dropped → ~0.4s (too fast), double-wait → ~2.4s (too slow).
  const t0 = Date.now();
  const { exited } = spawnTwin('read -t 1.2 x; echo "to rc=$?"');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /to rc=/, 'read -t returned');
  assert.ok(elapsed >= 1150, `waited the full 1.2s (${elapsed}ms)`);
  assert.ok(elapsed < 2200, `did not wait the timeout twice (${elapsed}ms)`);
});

test('read -t on a PIPED fd 0 reads the pipe, not the ring (poll routes by fd type)', async () => {
  // Regression for the poll_oneoff fd-routing bug: `printf x | read -t` dup2's a
  // pipe onto fd 0, but poll keyed on `fd===0` and waited on the empty stdin ring
  // instead of the pipe — so read -t timed out (rc=142, empty) with the data
  // stranded in the pipe. Only reproduces over a LIVE ring (here); under run()'s
  // fixedInput, closed() short-circuits poll and hides it. `printf x` has no
  // newline, so read legitimately returns 1 at EOF — the bug is the empty value
  // and the full-timeout wait, not the exit code.
  const t0 = Date.now();
  const { exited } = spawnTwin('printf x | { read -t 1 v; echo "v=[$v]"; }');
  const m = await exited;
  const elapsed = Date.now() - t0;
  assert.match(m.out, /v=\[x\]/, 'the piped byte was read, not lost to a ring wait');
  assert.ok(elapsed < 600, `did not wait out the 1s timeout (${elapsed}ms)`);
});

test('tuish sub-second timer probe detects "sub" over the ring (not a 1s escape timeout)', async () => {
  // The exact probe from tuish tui.sh:_tuish_init_timing. When poll misrouted the
  // piped fd 0 it timed out → the probe reported "second" → tuish ran with a 1s
  // escape-key timeout in the browser. It must report sub-second.
  const probe = `if { echo 1 | read -r -t'0.01' -n 1 2>/dev/null ;} || `
    + `{ echo 1 | read -r -t'0.01' -k1 -u0 2>/dev/null ;}; `
    + `then echo TIMING=sub; else echo TIMING=second; fi`;
  const { exited } = spawnTwin(probe);
  const m = await exited;
  assert.match(m.out, /TIMING=sub/, 'read -t honors sub-second timeouts on a piped probe');
});

test('blocking read parks and wakes promptly on write', async () => {
  const { writer, exited } = spawnTwin('read -r x; echo "got=[$x]"');
  // Let the guest reach the blocking read, then feed a line.
  await new Promise((res) => setTimeout(res, 150));
  const t0 = Date.now();
  writer.write(enc.encode('hello\n'));
  const m = await exited;
  const wake = Date.now() - t0;
  assert.match(m.out, /got=\[hello\]/);
  assert.ok(wake < 1000, `woke promptly after the write (${wake}ms)`);
});

test('input arriving byte-by-byte accumulates into one line', async () => {
  const { writer, exited } = spawnTwin('read -r x; echo "word=[$x]"');
  await new Promise((res) => setTimeout(res, 100));
  for (const ch of ['a', 'b', 'c', '\n']) {
    writer.write(enc.encode(ch));
    await new Promise((res) => setTimeout(res, 10));
  }
  const m = await exited;
  assert.match(m.out, /word=\[abc\]/);
});

test('end() delivers EOF: while read terminates', async () => {
  const { writer, exited } = spawnTwin('n=0; while read -r _; do n=$((n+1)); done; echo "n=$n"');
  await new Promise((res) => setTimeout(res, 100));
  writer.write(enc.encode('one\ntwo\n'));
  await new Promise((res) => setTimeout(res, 50));
  const t0 = Date.now();
  writer.end();
  const m = await exited;
  assert.match(m.out, /n=2/);
  assert.ok(Date.now() - t0 < 5000, 'EOF woke the parked read, not the 30s recheck');
});

test('interactive loop: guest echoes multiple inputs then quits on command', async () => {
  const { writer, exited } = spawnTwin(
    'while read -r cmd; do case "$cmd" in q) echo bye; exit 5;; *) echo "echo:$cmd";; esac; done'
  );
  await new Promise((res) => setTimeout(res, 100));
  writer.write(enc.encode('first\n'));
  await new Promise((res) => setTimeout(res, 30));
  writer.write(enc.encode('second\n'));
  await new Promise((res) => setTimeout(res, 30));
  writer.write(enc.encode('q\n'));
  const m = await exited;
  assert.match(m.out, /echo:first/);
  assert.match(m.out, /echo:second/);
  assert.match(m.out, /bye/);
  assert.equal(m.code, 5, 'exit code propagates');
});

// Only meaningful on a binary built with the winsize/winch C support (compiled
// at `npm run build:wasm`); probe the module's imports so these stay green on an
// older dist/busybox.wasm instead of hanging.
const WINCH_READY = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_winch');

test('session.resize() synthesizes SIGWINCH and stty size reports live dims', async (t) => {
  if (!WINCH_READY()) { t.skip('dist/busybox.wasm predates the winsize/winch build — run npm run build:wasm'); return; }
  // The guest traps WINCH, prints the freshly-queried size, and exits. It idles
  // in `read -t` (a poll wait — the winch chokepoint) until the resize lands.
  const script =
    'trap \'echo "WINCH $(stty size)"; exit 0\' WINCH; '
    + 'i=0; while [ $i -lt 40 ]; do read -t 0.1 _ 2>/dev/null; i=$((i+1)); done; '
    + 'echo NOWINCH';
  const { writer, exited } = spawnTwin(script);
  await new Promise((res) => setTimeout(res, 250)); // let it reach the read loop
  writer.resize(100, 40);                            // cols=100, rows=40
  const m = await exited;
  assert.match(m.out, /WINCH 40 100/, 'trap fired and `stty size` returned the live rows cols');
});

test('a resize reaches a shell parked in a BLOCKING read', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The idle shell, and the case the timed tests above cannot see: `read` with
  // no -t waits forever. It was delivered only when unrelated input arrived,
  // because the guest sat in fd_read while winch_dispatch lives at poll — so
  // the host now parks an untimed poll (where a resize can end the wait) and
  // reports EINTR, instead of claiming readable and letting the read block.
  const { writer, exited, live } = spawnTwin(
    "trap 'echo GOT_WINCH' WINCH; read -r x; echo \"after=[$x]\""
  );
  await new Promise((res) => setTimeout(res, 300));   // reach the blocking read
  const t0 = Date.now();
  writer.resize(100, 40);
  // Wait for the trap rather than sleeping a fixed span, so `wake` is the real
  // delivery latency and not whatever the sleep was.
  while (!/GOT_WINCH/.test(live()) && Date.now() - t0 < 2000) {
    await new Promise((res) => setTimeout(res, 10));
  }
  const wake = Date.now() - t0;
  const duringPark = live();
  writer.write(enc.encode('done\n'));                 // let the guest finish
  await exited;
  assert.match(duringPark, /GOT_WINCH/, 'the trap fired while parked, with NO input written');
  assert.ok(wake < 250, `delivered promptly (${wake}ms)`);
});

test('a resize does not disturb a read in a shell with no WINCH trap', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The other half of the same change. An untimed poll woken by a resize
  // returns EINTR, and `read` reports failure on EINTR — correct when a trap
  // asked to be told, wrong for every shell that never mentioned WINCH. The
  // guest's __wrap_poll re-parks when the dispatch reached no handler, so a
  // plain `read` must be untouched by any number of resizes.
  const { writer, exited, live } = spawnTwin('read -r x; echo "line=[$x]"');
  await new Promise((res) => setTimeout(res, 250));
  writer.resize(100, 40);
  writer.resize(70, 20);
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(live(), '', 'the read is still parked — no early return, no output');
  writer.write(enc.encode('hello\n'));
  const m = await exited;
  assert.match(m.out, /line=\[hello\]/, 'the read got its line, whole, after two resizes');
});

test('repeated resizes each fire (bb_got_signal is cleared, no read -t spin)', async (t) => {
  if (!WINCH_READY()) { t.skip('needs the winsize/winch build — run npm run build:wasm'); return; }
  // The first synthesized WINCH set libbb's bb_got_signal; if it isn't cleared,
  // every later `read -t` short-circuits to EINTR and the loop busy-spins — so
  // only the first resize would ever be seen. This asserts all three land, live.
  const { writer, exited } = spawnTwin(
    'n=0; trap \'n=$((n+1)); echo "R$n=$(stty size)"; [ $n -ge 3 ] && exit 0\' WINCH; '
    + 'i=0; while [ $i -lt 100 ]; do read -t 0.1 _ 2>/dev/null; i=$((i+1)); done; echo TIMEOUT'
  );
  await new Promise((res) => setTimeout(res, 200));
  writer.resize(100, 40); await new Promise((res) => setTimeout(res, 200));
  writer.resize(70, 20);  await new Promise((res) => setTimeout(res, 200));
  writer.resize(120, 50); const m = await exited;
  assert.match(m.out, /R1=40 100/, 'first resize');
  assert.match(m.out, /R2=20 70/,  'second resize (would be lost to the spin without the fix)');
  assert.match(m.out, /R3=50 120/, 'third resize');
});

// ─── the guest's own line editor ─────────────────────────────────────────────
// Everything above drives a shell running a SCRIPT. These drive a shell at its
// PROMPT, which until now this build could not reach at all.
//
// ash calls read_line_input() only when `iflag` is set, and it sets `iflag`
// only when isatty(0) && isatty(1) (shell/ash.c). wasi-libc answers isatty()
// from the WASI rights word, and the shim used to claim every right on stdio —
// FD_SEEK and FD_TELL included — which is precisely what "not a terminal"
// means. So libbb/lineedit.c was compiled in and never ran: no prompt, no echo,
// no history, no arrows, no Tab. `tty: true` drops those two bits.
//
// These assert on `live()` rather than the exit snapshot, because a shell at a
// prompt has not exited: the whole point is what it printed while parked.

// The editor redraws with \r + erase, so what is on screen is the tail of the
// stream, not a substring of it. Strip the control sequences and take the last
// prompt line.
const screen = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/[\r\n]/).filter(Boolean).pop() || '';
const settle = (ms = 400) => new Promise((res) => setTimeout(res, ms));

test('a tty gives the guest a prompt, and it echoes its own keystrokes', async () => {
  const { writer, live } = spawnTwin(null, { tty: true });
  await settle();
  assert.match(live(), /BusyBox v1\.38\.0.*built-in shell \(ash\)/s, 'the interactive banner');
  assert.match(live(), /# $/, 'and a prompt, which a non-interactive shell never prints');
  writer.write(enc.encode('ec'));
  await settle();
  // Nothing echoes for the shell here — no host, no line discipline — so this
  // is the guest doing it in raw mode, which only the line editor does.
  assert.match(screen(live()), /# ec$/, 'the guest echoed the keystrokes itself');
  writer.end();
});

test('Tab completes a command name', async () => {
  const { writer, live } = spawnTwin(null, { tty: true });
  await settle();
  writer.write(enc.encode('ec\t'));
  await settle();
  assert.match(screen(live()), /# echo $/, '"ec" + Tab became "echo " — one match, so a trailing space');
  writer.end();
});

test('Tab completes a file name, and marks a directory with a slash', async () => {
  const { writer, live } = spawnTwin(null, {
    tty: true, files: { '/only.txt': 'x', '/adir/inside.txt': 'y' },
  });
  await settle();
  writer.write(enc.encode('cat on\t'));
  await settle();
  assert.match(screen(live()), /# cat only\.txt $/, 'a file completes with a trailing space');
  writer.write(enc.encode('\x15cd adi\t'));  // ^U clears the line
  await settle();
  assert.match(screen(live()), /# cd adir\/$/, 'a directory completes with a slash and NO space, so the path can go on');
  writer.end();
});

test('an ambiguous Tab inserts the common prefix; a second Tab lists', async () => {
  const { writer, live } = spawnTwin(null, {
    tty: true, files: { '/pre_one.txt': 'a', '/pre_two.txt': 'b' },
  });
  await settle();
  writer.write(enc.encode('cat pre\t'));
  await settle();
  assert.match(screen(live()), /# cat pre_$/, 'the common prefix "pre_" went in, and no more');
  writer.write(enc.encode('\t'));
  await settle();
  assert.match(live(), /pre_one\.txt/, 'the second Tab listed both candidates');
  assert.match(live(), /pre_two\.txt/);
  writer.end();
});

test('completion sees host builtins, which no other name source knows about', async () => {
  // `mytool` is registered in the twin above. It is not an applet, not a shell
  // builtin, not a function and not a file on PATH — the registry lives in JS,
  // behind a lookup(name) that answers one name at a time. Completing it is the
  // whole reason the host-builtin contract grew an optional names().
  const { writer, live } = spawnTwin(null, { tty: true });
  await settle();
  writer.write(enc.encode('myto\t'));
  await settle();
  assert.match(screen(live()), /# mytool $/, '"myto" + Tab found the JS-backed command');
  writer.write(enc.encode('\r'));
  await settle();
  assert.match(live(), /mytool ran/, 'and the name it completed to actually runs');
  writer.end();
});

test('the Up arrow recalls the previous line', async () => {
  const { writer, live } = spawnTwin(null, { tty: true });
  await settle();
  writer.write(enc.encode('echo first\r'));
  await settle();
  assert.match(live(), /^first$/m, 'the command ran');
  writer.write(enc.encode('\x1b[A'));
  await settle();
  assert.match(screen(live()), /# echo first$/, 'Up put it back on the line');
  writer.end();
});

// --- prompt expansion (CONFIG_ASH_EXPAND_PRMT) --------------------------------
//
// Without it ash hands PS1 to the editor verbatim, so a prompt can report
// nothing about the shell it belongs to: `$?` prints as the two characters
// `$?`. That is what these assert against.

test('PS1 is expanded, so the prompt can report the last exit status', async () => {
  const { writer, live } = spawnTwin(null, { tty: true, env: { PS1: '[$?]$ ' } });
  await settle();
  assert.match(screen(live()), /^\[0\]\$ $/, 'a fresh shell has status 0');
  writer.write(enc.encode('false\r'));
  await settle();
  assert.match(screen(live()), /^\[1\]\$ $/, 'and the NEXT prompt carries what false returned');
  writer.write(enc.encode('true\r'));
  await settle();
  assert.match(screen(live()), /^\[0\]\$ $/, 'and goes back down again');
  writer.end();
});

test('an OSC marker in PS1 carries the status out to the page', async () => {
  // What a page wraps a terminal in: one escape per prompt saying "a command
  // finished, and here is its status". The bare marker fires either way; the
  // status is the half that needs the expansion. The newline is not decoration
  // — see the width test below.
  const { writer, live } = spawnTwin(null, {
    tty: true, env: { PS1: '\x1b]777;done;$?\x07\n$ ' },
  });
  await settle();
  writer.write(enc.encode('false\r'));
  await settle();
  assert.match(live(), /\x1b\]777;done;1\x07\n\$ $/, 'the marker ends with the real status');
  assert.doesNotMatch(live(), /done;\$\?/, 'and never with the literal $?');
  writer.end();
});

test('an escape on the prompt LAST LINE is measured as visible width', async () => {
  // FEATURE_EDITING_FANCY_PROMPT is off, so there are no \\[ \\] non-printing
  // markers and the editor measures the last prompt line with
  // unicode_strwidth() — escape bytes included. A 14-byte OSC left beside "$ "
  // reports 16 columns for 2, and the editor wraps that much early. Parking it
  // above the last line costs nothing, which is why the README puts it there.
  const OSC = '\x1b]777;done;$?\x07';
  const type = 'x'.repeat(30);                 // 30 chars after a 2-column prompt
  const run = async (PS1) => {
    const { writer, live } = spawnTwin(null, {
      tty: true, env: { PS1, COLUMNS: '40', LINES: '24' },
    });
    await settle();
    const banner = live().length;
    writer.write(enc.encode(type));
    await settle();
    const echoed = live().slice(banner);
    writer.end();                              // EOF, so the typed line never runs
    return echoed;
  };
  assert.doesNotMatch(await run('$ '), /\r\n/, 'a 2-column prompt fits 30 characters on 40 columns');
  assert.doesNotMatch(await run(OSC + '\n$ '), /\r\n/, 'and so does one with the escape a line above');
  assert.match(await run(OSC + '$ '), /\r\n/, 'but on the same line the editor wraps mid-word');
});

test('a nested shell does not take the outer shell prompt with it', async () => {
  // Prompt expansion makes cmdedit_prompt an OWNED pointer — putprompt() frees
  // the previous copy before strdup'ing the next. ash_run_applet() saves and
  // restores that pointer across a nested shell whose allocations are
  // abandoned, so the nested shell's first prompt would free the outer's copy
  // and the restore would hand it back freed. See ash-nested-shell.patch.
  const { writer, live } = spawnTwin(null, { tty: true, env: { PS1: 'outer:$? ' } });
  await settle();
  // Single-quoted: the OUTER shell must not expand $? here, or the nested
  // shell inherits a prompt with the status already baked in.
  writer.write(enc.encode("PS1='inner:$? ' sh\r"));
  await settle();
  assert.match(screen(live()), /^inner:0 $/, 'the nested shell draws its own prompt');
  writer.write(enc.encode('false\r'));
  await settle();
  assert.match(screen(live()), /^inner:1 $/, 'and expands its own PS1, not the outer one');
  writer.write(enc.encode('true\r'));
  await settle();
  writer.write(enc.encode('exit\r'));
  await settle();
  assert.match(screen(live()), /^outer:0 $/, 'and the outer prompt comes back intact');
  writer.write(enc.encode('echo still-here\r'));
  await settle();
  assert.match(live(), /^still-here$/m, 'with a shell that still runs commands');
  writer.end();
});

test('without a tty none of that happens, and that is the default', async () => {
  // The compatibility guarantee: an embedder that edits lines in the page (both
  // of ours do) must not suddenly get a second echo of every line from the
  // guest. Opting in is the only way to turn the editor on.
  const { writer, live } = spawnTwin(null, {});
  await settle();
  assert.equal(live(), '', 'no banner and no prompt');
  writer.write(enc.encode('ec\t'));
  await settle();
  assert.equal(live(), '', 'and no echo — the bytes are just stdin');
  writer.end();
});
