// The worker half of examples/host-port.html.
//
// A capability object is a bag of FUNCTIONS, so it cannot be structured-cloned
// into a worker any more than host builtins can. It is registered HERE, and the
// page points spawn() at this module with `workerUrl` — which is the only way
// an interactive session gets a port at all.
//
// serve() is called SYNCHRONOUSLY, as the last thing this module does and
// before any top-level await: a startup message that arrives while the module
// is suspended is delivered to no one, and the shell would run with no port.
import { serve } from '../src/worker.mjs';

const dec = new TextDecoder();

// Exported so the suite can drive these verbs headlessly (test/serve.test.mjs)
// — a factory is just a function, and keeping it separable costs nothing.
//
// Async setup happens once, here, before the shell starts, the same shape host
// builtins use. A VERB is synchronous: the guest is a wasm stack frame below
// the call, so there is nothing to await into.
export async function host() {
  await Promise.resolve();

  return {
    // The reply half of a request. Inbound has no return value to fill — the
    // guest is parked in a read, with no write to fail and no $? to reach — so
    // an answer leaves the same way any other outbound message does.
    //
    // spawn() ignores message types it does not know, so a worker module may
    // talk to its own page alongside the session's own traffic.
    respond(payload) {
      const line = dec.decode(payload);
      const sp = line.indexOf(' ');
      self.postMessage({
        type: 'response',
        status: Number(sp < 0 ? line : line.slice(0, sp)) || 0,
        body: sp < 0 ? '' : line.slice(sp + 1),
      });
    },

    // Outbound with nothing inbound about it: the script asking the page for
    // something only the page has. Read at call time rather than awaited,
    // which is what "a verb is synchronous" means in practice — an async
    // browser API is staged by the page instead, where there is a task to
    // await in.
    now: () => new Date().toLocaleTimeString(),
  };
}

serve({ host });
