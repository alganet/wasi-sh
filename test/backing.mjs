// A backend shaped like `@zenfs/dom`'s WebAccessFS: `Async(IndexFS)` with an
// InMemory cache, over a Map instead of over OPFS. Not a mock of an interface
// — it is the real hydrate-and-flush machinery, the queue and the recursion
// guard included, in the one place node can drive it.
//
// Shared by fs-persist.test.mjs and fs-journal.test.mjs, which need the same
// double for the same reason: there is no FileSystemDirectoryHandle here.
//
// A DEV DEPENDENCY ONLY: `npm i wasi-sh` must keep installing exactly one thing.
const ENC = new TextEncoder();

/** `failOn` is the lever that makes one write-back fail, as a full quota does. */
export function makeBacking(core, seed = {}) {
  const bytes = new Map([['/', null]]);
  class MapBacking extends core.Async(core.IndexFS) {
    _sync = core.InMemory.create({ label: 'persist-cache' });
    failOn = null;
    constructor() { super(0x6d617062, 'mapbacking'); }
    async _load() {
      for (const [path, data] of bytes) {
        this.index.set(path, new core.Inode(data === null
          ? { mode: 0o755 | core.constants.S_IFDIR, size: 0 }
          : { mode: 0o644 | core.constants.S_IFREG, size: data.length, mtimeMs: Date.now() }));
      }
    }
    async stat(path) { return super.stat(path); }
    async readdir(path) { return super.readdir(path); }
    async read(path, buffer, offset, end) {
      const data = bytes.get(path);
      if (data == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', errno: 2 });
      buffer.set(data.subarray(offset, end));
    }
    async write(path, buffer, offset) {
      if (this.failOn === path) throw Object.assign(new Error('quota exceeded'), { code: 'ENOSPC', errno: 28, path });
      const old = bytes.get(path) || new Uint8Array(0);
      const next = new Uint8Array(Math.max(old.length, offset + buffer.length));
      next.set(old); next.set(buffer, offset);
      bytes.set(path, next);
    }
    // Faithful to OPFS on purpose: `removeEntry()` on a name the directory
    // does not have throws NotFoundError, and a backend whose `remove` is a
    // `Map.delete` cannot show what that costs. See ZENFS.md finding 10.
    async remove(path) {
      if (!bytes.has(path)) {
        throw Object.assign(new Error('A requested file or directory could not be found at the time an operation was processed.'),
          { code: 'ENOENT', errno: 2, path });
      }
      bytes.delete(path);
    }
    removeSync() { /* the cache does the synchronous half */ }
    async _mkdir(path) { bytes.set(path, null); }
  }
  for (const [path, text] of Object.entries(seed)) {
    const parts = path.split('/').slice(1, -1);
    let dir = '';
    for (const p of parts) { dir += '/' + p; if (!bytes.has(dir)) bytes.set(dir, null); }
    bytes.set(path, ENC.encode(text));
  }
  return { bytes, make: async () => { const fs = new MapBacking(); await fs._load(); return fs; } };
}
