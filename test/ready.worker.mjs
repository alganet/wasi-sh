// A worker module that uses serve({ ready }) — the setup half of ready.test.mjs.
//
// It answers a probe with what the hook was handed, which is the only way to
// see the hook at all: everything it gives out exists solely on this thread.
import { serve } from '../src/worker.mjs';

/** Set by a builtin, which can only run once the GUEST is running. */
let guestRan = false;
/** What ready() was handed, and whether the guest had started by then. */
let seen = null;
const probes = [];

function report() {
  const { fs } = seen;
  return {
    type: 'probe.result',
    readyBeforeGuest: seen.readyBeforeGuest,
    suspendable: seen.suspendable,
    suspendInput: seen.suspendInput,
    fsShape: Object.keys(fs).sort(),
    // The point of handing a filesystem over: this thread can read what the
    // guest runs on WITHOUT being called by the guest.
    seeded: new TextDecoder().decode(fs.read('/seed.txt') || new Uint8Array(0)),
    // And write it, which is what an editor beside a terminal does.
    wrote: fs.write('/from-host.txt', 'host was here'),
  };
}

self.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'probe') return;
  if (seen) self.postMessage(report());
  else probes.push(1);
});

serve({
  ready(session) {
    seen = { ...session, readyBeforeGuest: !guestRan };
    while (probes.length) { probes.pop(); self.postMessage(report()); }
  },
  builtins: () => ({
    mark: (ctx) => { guestRan = true; ctx.stdout('marked\n'); return 0; },
  }),
});
