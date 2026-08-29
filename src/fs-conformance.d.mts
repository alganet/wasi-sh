import type { FileSystem } from './fs.mjs';

/** One check. `dir` is a directory path the case owns and creates itself. */
export interface ConformanceCase {
  name: string;
  /** Throws a plain Error describing the first failure. */
  run(fs: FileSystem, dir: string): void;
}

/**
 * What a store must do to back a WasiShim, in dependency order — the earliest
 * failure is the most useful one to read.
 *
 * Runner-agnostic: cases depend on nothing and throw on failure, so the same
 * suite runs under `node --test`, in a browser, or through checkConformance().
 */
export function conformanceCases(): ConformanceCase[];

export interface ConformanceReport {
  passed: string[];
  failed: Array<{ name: string; error: Error }>;
}

/** Run every case against one store, for a CI with no test runner. */
export function checkConformance(
  create: () => FileSystem,
  options?: { prefix?: string },
): ConformanceReport;
