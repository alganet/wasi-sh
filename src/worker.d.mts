/**
 * Worker entry module — reference it by URL, don't import it:
 *   new Worker(new URL('wasi-sh/worker', import.meta.url), { type: 'module' })
 *
 * Startup message: { module | wasmBytes, files, args, env, sab?, stdin? }
 *   sab    → interactive mode (RingReader on the SAB stdin ring)
 *   stdin  → non-interactive mode (fixed buffer, then EOF)
 * Outbound: { type:'out', channel:'stdout'|'stderr', bytes }
 *           { type:'ready' } | { type:'exit', code } | { type:'error', msg }
 */
export {};
