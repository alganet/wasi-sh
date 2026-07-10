#!/usr/bin/env node
// Static dev server with the cross-origin-isolation headers SharedArrayBuffer
// needs (spawn()'s interactive sessions). run()-only pages work on any host.
//   node scripts/serve.mjs [--port 8000] [--root <dir>]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('port', 8000));
const ROOT = normalize(opt('root', join(import.meta.dirname, '..')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm', // required for WebAssembly.compileStreaming
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(ROOT, path);
  if (file.endsWith('/') || path === '/') file = join(file, 'index.html');
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      // Cross-origin isolation: what makes SharedArrayBuffer available.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end(`404 ${path}\n`);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/examples/run-script.html   (run(), no isolation needed)`);
  console.log(`  http://localhost:${PORT}/examples/dumb-terminal.html`);
  console.log(`  http://localhost:${PORT}/examples/repl.html`);
});
