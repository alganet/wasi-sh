// What a guest turn looks like on the wire.
//
// The shim hands stdout and stderr one call per write() syscall, and for a long
// time each of those was its own postMessage. A page turns each message into a
// `term.write()` in a task of its own, and a browser may paint between any two
// tasks — so a redraw made of fragments was WATCHED happening. Measured in
// Firefox: `^C`-L at a prompt is the line editor emitting ESC[H ESC[J, then a
// carriage return, then the prompt, then ESC[J, and the caret was seen
// travelling to column 0 and back. Chromium coalesced the paints, which is why
// this hid; tuish repaints are made of the same fragments.
//
// So serve() batches a turn and flushes it when the guest PARKS. These count
// messages, because the message count is the thing that was wrong — the bytes
// were always right.
import { test, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createStdinRing, RingWriter } from '../src/ring.mjs';

let wasm;
before(async () => {
  wasm = new Uint8Array(await readFile(new URL('../dist/busybox.wasm', import.meta.url)));
});

const TWIN = new URL('./worker-twin.mjs', import.meta.url);
const MODULE = new URL('./plain.worker.mjs', import.meta.url).href;
const enc = new TextEncoder();
const dec = new TextDecoder();
const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms));

/** An interactive shell in the real worker, with every `out` message kept whole. */
async function shell() {
  const sab = createStdinRing();
  const writer = new RingWriter(sab);
  const worker = new Worker(TWIN, { workerData: { module: MODULE } });
  let messages = [];
  worker.on('message', (m) => { if (m.type === 'out') messages.push(m); });
  await settle(300);
  worker.postMessage({
    wasmBytes: wasm, files: {}, args: ['busybox', 'sh'],
    env: { PATH: '/', LC_ALL: 'C', PS1: '# ' }, sab, tty: true,
  });
  await settle(900);
  return {
    type: (text) => writer.write(enc.encode(text)),
    /** Every `out` message since the last call, as [{channel, text}, ...] per message. */
    take() {
      const got = messages.map((m) => (m.runs || [m]).map((r) => ({
        channel: r.channel, text: dec.decode(new Uint8Array(r.bytes)),
      })));
      messages = [];
      return got;
    },
    async stop() { writer.end(); await settle(300); await worker.terminate(); },
  };
}

describe('a guest turn travels as one message', () => {
  test('Enter: the newline, the output and the next prompt arrive together', async () => {
    const sh = await shell();
    try {
      sh.type('echo hi');
      await settle();
      sh.take();
      sh.type('\r');
      await settle();
      const messages = sh.take();

      assert.equal(messages.length, 1,
        `one message, not one per write — got ${JSON.stringify(messages)}`);
      // The runs stay separate and in order, because onOutput(bytes, channel)
      // is the contract: run() splits its stdout from its stderr with it.
      assert.deepEqual(messages[0], [
        { channel: 'stderr', text: '\n' },      // the line editor ending the line
        { channel: 'stdout', text: 'hi\n' },    // the command
        { channel: 'stderr', text: '# ' },      // and the prompt that follows it
      ]);
    } finally { await sh.stop(); }
  });

  test('^L: a whole redraw, so nothing can paint through the middle of it', async () => {
    const sh = await shell();
    try {
      sh.type('echo hi\r');
      await settle();
      sh.take();
      sh.type('\x0c');
      await settle();
      const messages = sh.take();

      assert.equal(messages.length, 1, `one message — got ${JSON.stringify(messages)}`);
      // The four fragments a terminal was previously given one at a time, and
      // between any two of which it was free to paint. The prompt is in the
      // MIDDLE of them — the redraw ends by clearing what the old line left —
      // which is exactly why watching them arrive separately looked like the
      // caret travelling to column 0 and back.
      const text = messages[0].map((r) => r.text).join('');
      assert.match(text, /\x1b\[H\x1b\[J/, 'home and clear');
      assert.match(text, /\r/, 'the carriage return that puts the caret at column 0');
      assert.match(text, /# /, 'the prompt');
      assert.match(text, /\x1b\[J$/, 'and the clear that ends the redraw');
    } finally { await sh.stop(); }
  });

  test('an empty write is not output, and costs nothing', async () => {
    // Three of ^L's seven writes were empty. Each was a message, a structured
    // clone and a paint to say nothing at all.
    const sh = await shell();
    try {
      sh.type('echo hi\r');
      await settle();
      sh.take();
      sh.type('\x0c');
      await settle();
      for (const message of sh.take()) {
        for (const run of message) assert.notEqual(run.text, '', 'no empty run');
      }
    } finally { await sh.stop(); }
  });

  test('output still streams while a command is running', async () => {
    // The cap, which is what keeps batching from turning a long command into
    // silence: nothing unwinds mid-command without JSPI, so a turn that never
    // parks has to flush on size instead.
    const sh = await shell();
    try {
      sh.take();
      sh.type('seq 1 40000\r');
      await settle(2500);
      const messages = sh.take();
      assert.ok(messages.length > 1,
        `a long command flushes as it goes — got ${messages.length} message(s)`);
    } finally { await sh.stop(); }
  });
});

// ─── the other two ways a turn ends ──────────────────────────────────────────
// The batch is flushed when the guest stops writing, and parking on a keystroke
// is only the most obvious way it does. These two were missed the first time,
// and neither is visible in a message COUNT — one is latency, one is order.
describe('a turn also ends when the guest hands the thread away', () => {
  test('the /dev/hostreq park flushes first, like stdin\'s does', async () => {
    // A dev server between requests is parked HERE, not on stdin, and the park
    // is unbounded: whatever it printed before waiting sat in the batch until a
    // request arrived. Measured before the fix: written at +305ms, delivered at
    // +2304ms, and only because something was finally posted.
    const { WasiShim } = await import('../src/shim.mjs');
    const order = [];
    const requests = {
      pollReadable: (ms) => { order.push(`park(${ms})`); return false; },
      read: () => new Uint8Array(0),
      closed: () => false,
    };
    const shim = new WasiShim({ requests, beforeBlock: () => order.push('flush') });
    const memory = new WebAssembly.Memory({ initial: 2 });
    shim.bindMemory(memory);
    const p1 = shim.imports().wasi_snapshot_preview1;
    const view = () => new DataView(memory.buffer);

    const path = enc.encode('/dev/hostreq');
    new Uint8Array(memory.buffer).set(path, 0x100);
    assert.equal(p1.path_open(3, 0, 0x100, path.length, 0, 0n, 0n, 0, 0x200), 0);
    const fd = view().getUint32(0x200, true);

    // clock + fd_read on the device, which is the shape `read -t` produces.
    view().setBigUint64(0x300, 1n, true); view().setUint8(0x308, 0);
    view().setBigUint64(0x300 + 24, 20_000_000n, true);            // 20ms
    view().setBigUint64(0x330, 2n, true); view().setUint8(0x338, 1);
    view().setUint32(0x330 + 16, fd, true);
    p1.poll_oneoff(0x300, 0x500, 2, 0x600);

    assert.deepEqual(order, ['flush', 'park(20)'],
      'the flush has to come BEFORE the wait, not after it');
  });

  test('a call out to embedder code flushes first, so nothing overtakes it', async () => {
    // A host verb and a host builtin may postMessage to the page themselves —
    // examples/host-port.worker.mjs answers a request exactly that way. Held
    // output would then arrive AFTER a message about it. Reproduced before the
    // fix: both responses landed ahead of every line of the script.
    const { compileWasm } = await import('../src/node.mjs');
    const module = await compileWasm();
    const posted = [];
    const handlers = [];
    const realSelf = globalThis.self;
    globalThis.self = {
      addEventListener(t, fn) { if (t === 'message') handlers.push(fn); },
      postMessage(m) { posted.push(m); },
    };
    try {
      await import('../examples/host-port.worker.mjs');
      await Promise.all(handlers.map((fn) => fn({ data: {
        module,
        files: { '/t.sh': 'echo one\nprintf "respond 1 alpha\\n" > /dev/host\necho two\n' },
        args: ['busybox', 'sh', '/t.sh'], env: { LC_ALL: 'C' }, stdin: '',
      } })));
    } finally { globalThis.self = realSelf; }

    const stream = posted.flatMap((m) => (m.type === 'out'
      ? (m.runs || [m]).map((r) => dec.decode(new Uint8Array(r.bytes)))
      : m.type === 'response' ? ['<response>'] : []));
    assert.deepEqual(stream, ['one\n', '<response>', 'two\n'],
      'program order, not every message ahead of every byte');
  });
});
