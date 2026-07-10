// Node conveniences over run(): filesystem-flavored helpers that must never
// enter a browser bundle — import from 'wasi-sh/node' only in node. run()
// itself already works in node (inline is the node default); these helpers
// add fs sugar: compile-once module loading and directory mounting.
import { readFile, readdir } from 'node:fs/promises';
import { run } from './run.mjs';
import { DEFAULT_WASM_URL } from './options.mjs';

export { run };

// Compile the wasm once (e.g. in a test suite's before hook) and pass the
// module to many run() calls.
export async function compileWasm(pathOrUrl = DEFAULT_WASM_URL) {
  const url = pathOrUrl instanceof URL ? pathOrUrl : new URL(pathOrUrl, `file://${process.cwd()}/`);
  return WebAssembly.compile(await readFile(url));
}

// Run a script string hermetically; sugar for run({ script, inline: true }).
export async function runScript(script, options = {}) {
  return run({ ...options, script, inline: true });
}

// Mount a directory tree from disk as a { '/mount/rel': content } files map.
//   filter(rel)            keep a file (default: all)
//   transform(path, text)  rewrite text content before mounting
//   binary(rel)            fetch as bytes, skipping transform (default: none)
export async function readTree(dir, { mount = '/', filter, transform, binary } = {}) {
  const root = dir instanceof URL ? dir : new URL(`${dir.replace(/\/$/, '')}/`, `file://${process.cwd()}/`);
  const files = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  await Promise.all(entries.filter((d) => d.isFile()).map(async (d) => {
    const rel = d.parentPath && d.parentPath !== root.pathname.replace(/\/$/, '')
      ? `${d.parentPath.slice(root.pathname.length)}/${d.name}`.replace(/^\//, '')
      : d.name;
    if (filter && !filter(rel)) return;
    const abs = new URL(rel, root);
    const mounted = `${mount.replace(/\/$/, '')}/${rel}`;
    if (binary && binary(rel)) {
      files[mounted] = new Uint8Array(await readFile(abs));
    } else {
      const text = await readFile(abs, 'utf8');
      files[mounted] = transform ? transform(mounted, text) : text;
    }
  }));
  return files;
}
