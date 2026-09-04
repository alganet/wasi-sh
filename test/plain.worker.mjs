// The stock worker: serve() with nothing added.
//
// For a twin that wants to watch what serve() PUTS ON THE WIRE rather than what
// a builtin does — see output-batching.test.mjs, which counts messages.
import { serve } from '../src/worker.mjs';

serve({});
