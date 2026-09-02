// The guest's side of fs-journal.test.mjs: a worker that builds a journalFs
// and then behaves like a running session — including PARKING in Atomics.wait,
// which is the state the whole item exists for. A scenario is named rather
// than sent as code so the blocking half is real: a worker driven by messages
// would have to turn its event loop to receive them, which is precisely what a
// live guest never does.
import { workerData, parentPort } from 'node:worker_threads';
import { journalFs } from '../src/fs.mjs';
import { WasiShim, WasiExit } from '../src/shim.mjs';
import { RingReader } from '../src/ring.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const { sab, snapshot, scenario } = workerData ?? {};
const NEW_FILE = { mode: 0o644, uid: 0, gid: 0 };
const NEW_DIR = { mode: 0o755, uid: 0, gid: 0 };

const say = (message) => parentPort.postMessage(message);
const fail = (err) => say({ error: `${(err && err.code) || ''} ${(err && err.message) || err}`.trim() });

// Park exactly as a shell on /dev/hostreq does: one synchronous frame, no
// event loop turn, nothing draining behind it.
const park = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const read = (fs, path) => {
  const { size } = fs.statSync(path);
  const buf = new Uint8Array(size);
  if (size) fs.readSync(path, buf, 0, size);
  return DEC.decode(buf);
};

// Everything in test/ is a test FILE to `node --test`, and this one is not:
// it is the other end of a worker. Nothing runs unless a scenario was handed
// in, so discovery finds a module with no cases rather than a failing one.
async function runScenario() {
  try {
    const fs = journalFs(sab, snapshot);

    if (scenario === 'write-then-park') {
      fs.mkdirSync('/srv', NEW_DIR);
      fs.createFileSync('/srv/live.txt', NEW_FILE);
      fs.writeSync('/srv/live.txt', ENC.encode('written from inside a running guest'), 0);
      say('written');
      park(1500);                       // the session is still up, and stays up
      say('woke');
    } else if (scenario === 'read-snapshot') {
      say({ index: read(fs, '/srv/index.php'), listing: fs.readdirSync('/srv') });
    } else if (scenario === 'sync') {
      fs.createFileSync('/a.txt', NEW_FILE);
      fs.writeSync('/a.txt', ENC.encode('sync me'), 0);
      fs.syncSync();
      say('synced');
    } else if (scenario === 'empty-file') {
      fs.createFileSync('/empty.txt', NEW_FILE);
      fs.syncSync();
      say('made');
    } else if (scenario === 'touch-then-remove') {
      // What a prompt does: `touch a; rm a`. Both halves are ordinary calls
      // and the guest never learns that the backend saw neither.
      fs.createFileSync('/scratch.txt', NEW_FILE);
      fs.unlinkSync('/scratch.txt');
      fs.syncSync();
      // The store has to still take writes. A write-back failure latches, and
      // journalFs raises it at the NEXT mutation — so this is the call that
      // used to be EIO, with `mkdir: I/O error` at the prompt behind it.
      fs.mkdirSync('/after', NEW_DIR);
      fs.createFileSync('/after/ok.txt', NEW_FILE);
      fs.writeSync('/after/ok.txt', ENC.encode('still working'), 0);
      fs.syncSync();
      say('survived');
    } else if (scenario === 'reports-a-failure') {
      // Writes to a file the backing store was SEEDED with, rather than
      // creating one. A file this guest created is `hollow` in persistentFs
      // until something writes to it, and a flush materializes it with a
      // zero-length write of its own (ZENFS.md finding 10) — so a create+write
      // that the drain happens to split across two batches attempts TWO writes
      // to the failing path and honestly reports two failures. That is correct
      // behaviour and a nondeterministic count; the failure being counted here
      // is the writer reporting ONE write twice, which needs one write to be
      // unambiguous. The hollow path gets its own case below.
      fs.writeSync('/nope.txt', ENC.encode('too much'), 0);
      try { fs.syncSync(); fail(new Error('syncSync did not raise')); }
      catch (err) { say({ raised: err.message, code: err.code }); }
      // Cleared by raising, exactly as persistentFs does it, so the next real
      // failure is not buried under a stale one.
      try { fs.syncSync(); say('quiet after'); } catch (err) { fail(err); }
    } else if (scenario === 'reports-a-failed-materialize') {
      // An empty file, never written to. Nothing the guest does asks the
      // backend for a byte, so the only write that ever reaches it is the
      // materialize persistentFs does at the flush — and that one failing is
      // the case a seeded file cannot cover.
      fs.createFileSync('/nope.txt', NEW_FILE);
      try { fs.syncSync(); fail(new Error('syncSync did not raise')); }
      catch (err) { say({ raised: err.message, code: err.code }); }
    } else if (scenario === 'refuses-a-bad-op-without-journaling') {
      try { fs.mkdirSync('/srv', NEW_DIR); } catch (err) { say({ refused: err.code }); }
      fs.createFileSync('/after.txt', NEW_FILE);
      fs.writeSync('/after.txt', ENC.encode('still working'), 0);
      fs.syncSync();
      say('done');
    } else if (scenario === 'big-write') {
      const big = new Uint8Array(300000);
      for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
      fs.createFileSync('/big.bin', NEW_FILE);
      fs.writeSync('/big.bin', big, 0);
      fs.syncSync();
      say({ wrote: big.length, cached: fs.statSync('/big.bin').size });
    } else if (scenario === 'writer-goes-away') {
      say('ready');
      park(400);                        // the writer is stopped during this
      try {
        fs.createFileSync('/x.txt', NEW_FILE);
        say({ error: 'createFileSync succeeded with no writer' });
      } catch (err) {
        let cached = true;
        try { fs.statSync('/x.txt'); } catch { cached = false; }
        say({ error: `${err.code} ${err.message}`, cached });
      }
    } else if (scenario === 'real-shell') {
      // The criterion MOAR §4.3b names, with nothing simulated: a busybox ash
      // parked on /dev/hostreq, writing through the store, in a session that
      // does not end. Its _start() frame is the same one every claim about law 1
      // is about — while it runs, nothing else on this thread does.
      const shim = new WasiShim({
        args: ['busybox', 'sh', '/t.sh'],
        env: { PATH: '/', LC_ALL: 'C' },
        files: { '/t.sh': workerData.script },
        fs,
        stdout: (b) => say({ out: DEC.decode(b) }),
        stderr: (b) => say({ out: DEC.decode(b) }),
        requests: new RingReader(workerData.reqSab).toInput(),
      });
      const instance = await WebAssembly.instantiate(workerData.module, shim.imports());
      shim.bindMemory(instance.exports.memory);
      try { instance.exports._start(); }
      catch (err) { if (!(err instanceof WasiExit)) throw err; say({ exited: err.code }); }
    } else {
      fail(new Error(`unknown scenario '${scenario}'`));
    }
  } catch (err) {
    fail(err);
  }
}

if (scenario) await runScenario();
