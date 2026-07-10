import type { Files } from './shim.mjs';
import type { RunOptions, RunResult } from './run.mjs';

export { run } from './run.mjs';

/** Compile the bundled (or given) wasm once, for many run() calls. */
export function compileWasm(pathOrUrl?: URL | string): Promise<WebAssembly.Module>;

/** Run a script string hermetically; sugar for run({ script, inline: true }). */
export function runScript(script: string, options?: Omit<RunOptions, 'script'>): Promise<RunResult>;

export interface ReadTreeOptions {
  mount?: string;
  filter?: (rel: string) => boolean;
  transform?: (path: string, text: string) => string | Uint8Array;
  binary?: (rel: string) => boolean;
}

/** Mount a directory tree from disk as a files map. */
export function readTree(dir: URL | string, options?: ReadTreeOptions): Promise<Files>;
