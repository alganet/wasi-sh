import type { BuiltinMap, BuiltinRegistry } from './shim.mjs';

export { run } from './run.mjs';
export type { RunOptions, RunResult, WasmSource, OutputChannel } from './run.mjs';
export { spawn, Session } from './spawn.mjs';
export type { SpawnOptions } from './spawn.mjs';
export { fetchTree } from './files.mjs';
export type { FetchTreeOptions } from './files.mjs';
export { WasiShim, WasiExit } from './shim.mjs';
/**
 * A command namespace that can change while the session runs.
 *
 * Declared here rather than re-exported because it lives in an internal module
 * (`options.mjs`) that the package does not expose a subpath for — the type
 * would resolve and the runtime import would not.
 */
export declare function builtinRegistry(initial?: BuiltinMap): BuiltinRegistry;
export type {
  WasiShimOptions, ShimInput, ShimRequests, Files,
  HostBuiltins, BuiltinMap, BuiltinHandler, BuiltinContext, BuiltinRegistry, HostFs,
  HostPort, HostVerbMap, HostVerb,
} from './shim.mjs';
export { createRing, createStdinRing, RingWriter, RingReader, RingOverflowError, frameRequest } from './ring.mjs';
