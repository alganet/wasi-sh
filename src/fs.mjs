// The `fs` contract — the third pluggable seam, beside `input` and `builtins`.
//
// A store is a path-addressed, SYNCHRONOUS filesystem. Synchronous is not a
// preference: the guest is a wasm stack frame below every call, so there is
// nothing to await into (the same constraint host builtins live under).
//
// The shape is ZenFS's `FileSystem`, deliberately not one of our own:
//   statSync(path)                        -> InodeLike
//   readdirSync(path)                     -> string[]
//   createFileSync(path, options)         -> InodeLike
//   mkdirSync(path, options)              -> InodeLike
//   rmdirSync(path) / unlinkSync(path)
//   renameSync(from, to) / linkSync(target, link)
//   readSync(path, buffer, start, end)    positional, no fd state
//   writeSync(path, buffer, offset)       positional, no fd state
//   touchSync(path, metadata)             = truncate + chmod + utimes
//   syncSync()
// Borrowing it buys the ecosystem's stores for free — persistence, a
// SharedArrayBuffer-backed FS, copy-on-write layers, HTTP trees — and every
// gap in the map this replaced is already a field of `InodeLike`: byte offsets
// (no more read-whole-file-then-slice), truncate, mode bits, and timestamps.
//
// Timestamps are the one worth naming. The old map had none — filestat wrote
// 0 for atim/mtim/ctim — and a PHP runtime with opcache linked never
// invalidates a script whose mtime does not change. `InodeLike` makes them
// mandatory, which closes that by construction.
//
// TWO THINGS STAY OUT OF THE STORE, both on purpose:
//   - Open file descriptions. Offsets are ARGUMENTS here, so the `pos:{v}`
//     cell that POSIX shares across dup/dup2 never reaches a store and cannot
//     be got wrong by one.
//   - Devices. /dev/null and /dev/host are the shim's overlay,
//     so mounting a store never means writing device nodes into somebody's
//     real directory.
//
// Stores throw errors carrying LINUX errno — `.code` 'ENOENT', `.errno` 2 —
// because that is what the ecosystem's stores throw. The shim translates to
// WASI's numbering at its edge.

/**
 * Errors a store may throw, as LINUX errno numbers — every code the shim
 * knows how to translate. Not a short list on purpose: a `.code` with no entry
 * here would get a number that contradicts it.
 */
export const ERRNO = {
  EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EAGAIN: 11, ENOMEM: 12, EACCES: 13,
  EBUSY: 16, EEXIST: 17, EXDEV: 18, ENOTDIR: 20, EISDIR: 21, EINVAL: 22,
  ENFILE: 23, EMFILE: 24, EFBIG: 27, ENOSPC: 28, ESPIPE: 29, EROFS: 30,
  EMLINK: 31, EPIPE: 32, ENAMETOOLONG: 36, ENOSYS: 38, ENOTEMPTY: 39, ELOOP: 40,
};

/**
 * Build the error a store throws: `.code` is the name, `.errno` the number.
 *
 * An unknown code leaves `.errno` undefined rather than inventing one — a
 * wrong number is worse than a missing one, since a caller reading `.errno`
 * would get something plausible and false. Nothing is lost by it: the shim
 * translates by `.code`, not by `.errno`, and falls back to EIO for a name it
 * does not recognize, which is at least true.
 */
export function fsError(code, path) {
  const err = new Error(path === undefined ? code : `${code}: ${path}`);
  err.code = code;
  err.errno = ERRNO[code];
  if (path !== undefined) err.path = path;
  return err;
}

// The file type lives in `mode`, POSIX-style, so an InodeLike says what it is
// without a second field to disagree with.
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFCHR = 0o020000;

export const isDir = (mode) => (mode & S_IFMT) === S_IFDIR;
export const isFile = (mode) => (mode & S_IFMT) === S_IFREG;
export const isChar = (mode) => (mode & S_IFMT) === S_IFCHR;

/**
 * What a node is created with when the caller names no mode — and the caller
 * always should, because a store is entitled to take the contract literally.
 *
 * These are exported so the shim can pass them explicitly: `memoryFs` filling
 * them in is a courtesy, not a promise every store makes, and a store that
 * records exactly what it is given produced files no second guest could read.
 * See the note over `NEW_FILE` in shim.mjs.
 */
export const DEFAULT_DIR_MODE = 0o755;
export const DEFAULT_FILE_MODE = 0o644;
const ENC = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** `..` collapses and clamps at root; the result always starts with '/'. */
export function normalize(path) {
  const parts = String(path).split('/').filter((x) => x && x !== '.');
  const stack = [];
  for (const part of parts) { if (part === '..') stack.pop(); else stack.push(part); }
  return '/' + stack.join('/');
}

const parentOf = (path) => { const i = path.lastIndexOf('/'); return i > 0 ? path.slice(0, i) : '/'; };
const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The zero-dependency default store: everything in JS objects, nothing
 * persisted, state dies with the run.
 *
 * Writes are copy-on-write against `files` — a caller's mounted buffer is
 * never mutated, so the same seed can be handed to two shims.
 */
export function memoryFs(files = {}) {
  return new MemoryFs(files);
}

export class MemoryFs {
  constructor(files = {}) {
    // Flat map of absolute path -> node. Directories carry a Set of child
    // NAMES only: the child's own node is the single source of truth for its
    // type, so there is no stub to fall out of sync during a rename.
    this.nodes = new Map();
    // Inodes must be UNIQUE per node: busybox find/cp -r detect directory
    // loops by dev:ino, and a constant ino makes every directory look
    // infinitely recursive.
    this.nextIno = 2;
    this.nodes.set('/', this.#dirNode(1));
    this.mkdirSync('/tmp');
    for (const [path, content] of Object.entries(files)) this.#seed(path, content);
  }

  // ---- construction helpers ----

  // An empty directory starts at nlink 2 (its name and its own '.'); every
  // subdirectory adds one for its '..'. Some tools stop descending once they
  // have seen nlink-2 subdirectories, so a constant 2 hides a whole subtree —
  // the same shape of bug as a constant ino.
  #dirNode(ino, mode = DEFAULT_DIR_MODE) {
    const now = Date.now();
    return {
      ino, nlink: 2, mode: S_IFDIR | (mode & 0o7777), uid: 0, gid: 0,
      children: new Set(), atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now,
    };
  }

  #fileNode(ino, data, mutable, mode = DEFAULT_FILE_MODE) {
    const now = Date.now();
    return {
      ino, nlink: 1, mode: S_IFREG | (mode & 0o7777), uid: 0, gid: 0, data, mutable,
      atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now,
    };
  }

  // Mount one seed file, synthesizing its parent directories. `mutable: false`
  // marks the caller's buffer as borrowed — the first write copies it.
  #seed(path, content) {
    const abs = normalize(path.startsWith('/') ? path : `/${path}`);
    const segments = abs.split('/').filter(Boolean);
    let dir = '';
    for (let i = 0; i < segments.length - 1; i++) {
      dir = `${dir}/${segments[i]}`;
      const existing = this.#node(dir);
      if (!existing) this.mkdirSync(dir);
      else if (!isDir(existing.mode)) throw fsError('ENOTDIR', dir);
    }
    const clash = this.#node(abs);
    if (clash) {
      // Seeding a file over a directory would orphan its children — and would
      // quietly turn /tmp into a file.
      if (isDir(clash.mode)) throw fsError('EISDIR', abs);
      this.#detach(abs, clash);
      this.nodes.delete(abs);
    }
    let data, owned = true;
    if (typeof content === 'string') data = ENC.encode(content);
    else if (ArrayBuffer.isView(content) || content instanceof ArrayBuffer) {
      // A view over the caller's memory, NOT a copy — hence borrowed.
      data = ArrayBuffer.isView(content)
        ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
        : new Uint8Array(content);
      owned = false;
    } else data = new Uint8Array(content ?? 0);
    const node = this.#fileNode(this.nextIno++, data, owned);
    this.nodes.set(abs, node);
    this.#attach(abs, node);
  }

  // ---- internals ----

  // An empty path is ENOENT, not the root: normalize('') collapses to '/', and
  // POSIX has never let '' name anything.
  #node(path) { return path === '' ? null : this.nodes.get(normalize(path)) ?? null; }

  #require(path) {
    const node = this.#node(path);
    if (!node) throw fsError('ENOENT', path);
    return node;
  }

  #requireDir(path) {
    const node = this.#require(path);
    if (!isDir(node.mode)) throw fsError('ENOTDIR', path);
    return node;
  }

  // A file about to be modified in place: seeded buffers are borrowed, so the
  // first write takes a private copy.
  #writable(node) {
    if (!node.mutable) { node.data = node.data.slice(); node.mutable = true; }
    return node;
  }

  // Adding and removing a name are the only two places a directory's child
  // list, its nlink and its mtime change — kept together so they cannot drift.
  // A directory that gains an entry has been MODIFIED: leaving its mtime alone
  // is what makes a listing cache miss a deletion.
  #attach(abs, node) {
    const parent = this.#node(parentOf(abs));
    if (!parent || abs === '/') return;
    parent.children.add(baseOf(abs));
    if (isDir(node.mode)) parent.nlink++;
    this.#touched(parent);
  }

  #detach(abs, node) {
    const parent = this.#node(parentOf(abs));
    if (!parent || abs === '/') return;
    parent.children.delete(baseOf(abs));
    if (isDir(node.mode)) parent.nlink--;
    this.#touched(parent);
  }

  #touched(node, now = Date.now()) { node.mtimeMs = now; node.ctimeMs = now; }

  #stat(node) {
    return {
      ino: node.ino, nlink: node.nlink, size: node.data ? node.data.length : 0,
      mode: node.mode, uid: node.uid, gid: node.gid,
      atimeMs: node.atimeMs, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs,
      birthtimeMs: node.birthtimeMs,
    };
  }

  // ---- the contract ----

  statSync(path) { return this.#stat(this.#require(path)); }

  readdirSync(path) { return [...this.#requireDir(path).children]; }

  createFileSync(path, options = {}) {
    const abs = normalize(path);
    if (this.nodes.has(abs)) throw fsError('EEXIST', path);
    this.#requireDir(parentOf(abs));                  // ENOENT if it is missing
    const node = this.#fileNode(this.nextIno++, EMPTY, false, options.mode ?? DEFAULT_FILE_MODE);
    if (options.uid !== undefined) node.uid = options.uid;
    if (options.gid !== undefined) node.gid = options.gid;
    this.nodes.set(abs, node);
    this.#attach(abs, node);
    return this.#stat(node);
  }

  mkdirSync(path, options = {}) {
    const abs = normalize(path);
    if (this.nodes.has(abs)) throw fsError('EEXIST', path);
    this.#requireDir(parentOf(abs));
    const node = this.#dirNode(this.nextIno++, options.mode ?? DEFAULT_DIR_MODE);
    this.nodes.set(abs, node);
    this.#attach(abs, node);
    return this.#stat(node);
  }

  rmdirSync(path) {
    const abs = normalize(path);
    const node = this.#requireDir(abs);
    // Removing the root leaves a store where every path is ENOENT forever.
    if (abs === '/') throw fsError('EBUSY', path);
    if (node.children.size) throw fsError('ENOTEMPTY', path);
    this.nodes.delete(abs);
    this.#detach(abs, node);
  }

  unlinkSync(path) {
    const abs = normalize(path);
    const node = this.#require(abs);
    if (isDir(node.mode)) throw fsError('EISDIR', path);
    node.nlink--;
    node.ctimeMs = Date.now();
    this.nodes.delete(abs);
    this.#detach(abs, node);
  }

  renameSync(from, to) {
    const src = normalize(from), dst = normalize(to);
    const node = this.#require(src);
    this.#requireDir(parentOf(dst));
    if (src === dst) return;
    if (src === '/') throw fsError('EBUSY', from);
    if (isDir(node.mode) && dst.startsWith(`${src}/`)) throw fsError('EINVAL', to);  // into itself
    // Every refusal is decided before anything moves: a rename that throws
    // must leave the tree exactly as it found it.
    const existing = this.#node(dst);
    if (existing) {
      if (isDir(existing.mode)) {
        if (!isDir(node.mode)) throw fsError('EISDIR', to);
        if (existing.children.size) throw fsError('ENOTEMPTY', to);
      } else if (isDir(node.mode)) throw fsError('ENOTDIR', to);
      existing.nlink--;
      this.nodes.delete(dst);
      this.#detach(dst, existing);
    }
    // The map is keyed by full path, so a directory brings its subtree along.
    if (isDir(node.mode)) {
      const prefix = `${src}/`;
      for (const key of [...this.nodes.keys()]) {
        if (!key.startsWith(prefix)) continue;
        this.nodes.set(dst + key.slice(src.length), this.nodes.get(key));
        this.nodes.delete(key);
      }
    }
    this.#detach(src, node);
    this.nodes.delete(src);
    this.nodes.set(dst, node);
    this.#attach(dst, node);
    // Renaming touches the node's metadata, not its contents: bumping mtime
    // would make `mv`d files look freshly edited to find -newer and to make.
    node.ctimeMs = Date.now();
  }

  linkSync(target, link) {
    const src = normalize(target), dst = normalize(link);
    const node = this.#require(src);
    if (isDir(node.mode)) throw fsError('EPERM', target);   // POSIX: no dir links
    if (this.nodes.has(dst)) throw fsError('EEXIST', link);
    this.#requireDir(parentOf(dst));
    node.nlink++;
    node.ctimeMs = Date.now();
    this.nodes.set(dst, node);                              // one node, two names
    this.#attach(dst, node);
  }

  readSync(path, buffer, start, end) {
    const node = this.#require(path);
    if (isDir(node.mode)) throw fsError('EISDIR', path);
    const slice = node.data.subarray(start, end);
    const taken = Math.min(slice.length, buffer.length);
    buffer.set(slice.subarray(0, taken), 0);
    // A range reaching past EOF is short. Zero the tail rather than leaving
    // whatever the caller's buffer held — the shim reports read sizes from its
    // own clamp, and stale bytes here would surface as invented file content.
    if (taken < buffer.length) buffer.fill(0, taken);
    node.atimeMs = Date.now();
  }

  writeSync(path, buffer, offset) {
    const node = this.#require(path);
    if (isDir(node.mode)) throw fsError('EISDIR', path);
    this.#writable(node);
    const end = offset + buffer.length;
    if (end > node.data.length) {
      const grown = new Uint8Array(end);   // a write past EOF leaves a zero hole
      grown.set(node.data, 0);
      node.data = grown;
    }
    node.data.set(buffer, offset);
    this.#touched(node);
  }

  // chmod, chown, utimes and truncate, all in one call — `metadata` is a
  // partial InodeLike and only the fields present apply.
  touchSync(path, metadata = {}) {
    const node = this.#require(path);
    if (metadata.size !== undefined && !isDir(node.mode)) {
      const size = metadata.size;
      if (size !== node.data.length) {
        const next = new Uint8Array(size);
        next.set(node.data.subarray(0, Math.min(size, node.data.length)), 0);
        node.data = next;
        node.mutable = true;
      } else {
        this.#writable(node);
      }
      this.#touched(node);
    }
    // The type bits are the node's identity, never the caller's to rewrite.
    if (metadata.mode !== undefined) node.mode = (node.mode & S_IFMT) | (metadata.mode & 0o7777);
    if (metadata.uid !== undefined) node.uid = metadata.uid;
    if (metadata.gid !== undefined) node.gid = metadata.gid;
    if (metadata.atimeMs !== undefined) node.atimeMs = metadata.atimeMs;
    if (metadata.mtimeMs !== undefined) node.mtimeMs = metadata.mtimeMs;
    node.ctimeMs = metadata.ctimeMs !== undefined ? metadata.ctimeMs : Date.now();
  }

  syncSync() {}   // nothing behind memory to flush
}
