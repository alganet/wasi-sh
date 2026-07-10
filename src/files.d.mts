import type { Files } from './shim.mjs';

export interface FetchTreeOptions {
  /** URL of a JSON array of relative paths. */
  manifestUrl?: URL | string;
  /** Or the relative paths directly. */
  paths?: string[];
  /** Where the files live; rel paths are fetched as `${baseUrl}/${rel}`. */
  baseUrl: URL | string;
  /** Mount prefix inside the guest FS (default '/'). */
  mount?: string;
  /** Keep a file (default: all). */
  filter?: (rel: string) => boolean;
  /** Rewrite text content before mounting; `path` is the mounted absolute path. */
  transform?: (path: string, text: string) => string | Uint8Array;
  /** Fetch as bytes, skipping transform (default: none). */
  binary?: (rel: string) => boolean;
}

/** Assemble a files map from URLs (parallel fetches). Composes by spread. */
export function fetchTree(options: FetchTreeOptions): Promise<Files>;
