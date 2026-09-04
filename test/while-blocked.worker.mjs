// A worker module that answers a channel of its own while the guest is parked
// — the setup half of while-blocked.test.mjs.
//
// The channel is a second ring, handed over as an ordinary message the way a
// store is: nothing about it is a live object, and the startup message is
// recognised by the wasm it carries, so a module may have messages of its own.
import { serve } from '../src/worker.mjs';
import { RingReader } from '../src/ring.mjs';

/** The second channel, once the parent has handed it over. */
let requests = null;
/** Everything answered from inside the guest's park, in order. */
let answered = 0;

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'channel') return;
  requests = new RingReader(e.data.sab);
});

const dec = new TextDecoder();
let partial = '';

/**
 * Drain the channel and answer everything on it.
 *
 * It must drain — `pending()` is what ends the guest's park, so a run() that
 * leaves one line behind is asked again immediately and for ever. That is the
 * one rule this hook has, and this is what keeping it looks like: read until
 * the ring is empty, and hold an unterminated tail rather than answering half
 * a line.
 */
function run() {
  if (!requests) return;
  for (;;) {
    const bytes = requests.read(65536);
    if (!bytes.length) break;
    partial += dec.decode(bytes);
    let nl;
    while ((nl = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      answered++;
      // Posted from a thread whose guest is parked in Atomics.wait: the point
      // of the hook is that this happens at all, so the parent is told when.
      self.postMessage({ type: 'answered', line, answered });
    }
  }
}

serve({
  whileBlocked: { pending: () => !!requests && requests.readable, run },
  builtins: () => ({
    // How many were answered before this command ran — the guest's own view of
    // work that happened while it was waiting.
    answered: (ctx) => { ctx.stdout(`answered=${answered}\n`); return 0; },
  }),
});
