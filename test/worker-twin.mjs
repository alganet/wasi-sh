// A dedicated Worker, for node.
//
// A worker module's whole world is `self.addEventListener('message')` and
// `self.postMessage()`, so a `worker_threads` twin only has to supply those two
// and hand the port through. That is enough to run src/worker.mjs itself — the
// module an embedder's own worker imports `serve()` from — rather than a recipe
// re-derived beside it.
//
// Order matters twice. `self` has to exist before the module is imported,
// because it registers its listener at import; and the port is attached AFTER,
// because node queues messages until something listens and a message delivered
// to an empty handler list is simply lost.
import { parentPort, workerData } from 'node:worker_threads';

const handlers = [];
globalThis.self = {
  addEventListener(type, fn) { if (type === 'message') handlers.push(fn); },
  postMessage(message, transfer) { parentPort.postMessage(message, transfer); },
};

await import(workerData.module);

parentPort.on('message', (data) => { for (const fn of handlers) fn({ data }); });
parentPort.postMessage({ type: 'twin.ready' });
