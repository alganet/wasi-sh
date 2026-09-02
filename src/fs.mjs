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
// **The buffer a `writeSync` is handed is the store's to keep.** It is a copy
// made for that call, so a store that defers its write — every persistent one
// does — may hold it and read it whenever it gets round to it. Said here
// because the copy is made somewhere else (shim.mjs's `writeFd`) and looks like
// a spare one from there: the guest's iovec points into wasm memory it reuses
// on its next line, and passing that through by reference persisted two files
// as one file's bytes, with correct reads and a clean flush() the whole time.
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

// ---------------------------------------------------------------------------
// Persistence, as an adapter.
//
// The store contract is synchronous and every backend that outlives a tab is
// asynchronous, so the two only meet through hydrate-and-flush: read the whole
// tree into a synchronous cache before the guest starts, serve every call out
// of the cache, and pipeline the writes back out. That is not our model — it is
// ZenFS's `Async` mixin, which `@zenfs/dom`'s `WebAccessFS` already uses over
// any `FileSystemDirectoryHandle`, so OPFS and a user-granted host folder are
// one backend and neither is ours to write.
//
// What is ours is the seam, and it is three things the mixin leaves to the
// embedder — each of which is silent when it is got wrong:
//
//   HYDRATION IS NOT AUTOMATIC. `WebAccess.create()` loads the index and NOT
//   the cache; `ready()` is what fills it. A store handed over between the two
//   answers ENOENT for every file that is really there — so the shell sees an
//   empty project, and the first thing it writes shadows the real one.
//
//   A FAILED WRITE-BACK IS DROPPED. The mixin queues each write on a promise
//   chain and `sync()` awaits it with `.catch(() => {})`. A quota that filled
//   up or a folder permission that was revoked is therefore invisible: the
//   guest's write returned, the cache agrees with itself, and the bytes are
//   nowhere.
//
//   `syncSync()` CANNOT FLUSH ONE. It is the shim's one flush point — every
//   `proc_exit` calls it — and against an async backend all it can reach is the
//   cache. Nothing synchronous can await OPFS, so the honest answer is to
//   report what already failed and let the embedder await the rest.
//
//   AND `sync()` IS NOT A FLUSH POINT ON EVERY BACKEND. The three gaps above
//   are the `Async` mixin's; this fourth one is the gap where the mixin is not
//   there at all, and it is the worst of them because everything above it goes
//   on returning successfully. `@zenfs/dom`'s `WebAccessFS` is
//   `Async(IndexFS)`, so its `sync()` awaits the write-back chain and means
//   something. `@zenfs/dom`'s `IndexedDB.create()` returns a BARE `StoreFS`,
//   whose `sync()` is `async sync() { }` — an empty function — over a store
//   whose own `sync()` is `Promise.resolve()`. Its writes are neither queued on
//   a `_promise` this adapter can watch nor thrown from the call, so:
//
//     * `flush()` resolves immediately and promises nothing;
//     * `onError` never fires, because there is no queue to attach to;
//     * and `journalWriter` below, which flushes before it moves its tail,
//       moves it over writes that have not landed.
//
//   Measured, in Chromium and Firefox both: 300/600/1200 files through
//   `IndexedDB` flush in 0 ms at every size, where the same writes through
//   `WebAccess` take 355/738/1686 ms. A page that reloaded on the strength of
//   the first number kept 3 files of 2041.
//
//   There is no way to TELL from here — a bare `StoreFS` over an asynchronous
//   store is indistinguishable from one over a synchronous store, which is
//   `InMemory` and perfectly honest. So the backend's own barrier is the
//   embedder's to supply: `persistentFs(backing, { commit })`, awaited by
//   `flush()`. {@link indexedDbFlushPoint} is that barrier for this case.
//
// AND ONE LIMIT THAT IS LAW 1 RATHER THAN A GAP TO CLOSE — read this before
// reaching for it. **A guest that never exits never flushes.** The write-back
// is a promise chain and promises need the event loop, which a running guest
// does not give back: a live session is one synchronous `_start()` frame that
// parks in `Atomics.wait`, so not one microtask runs between its first write
// and its last. Measured rather than assumed — a shell parked on
// `/dev/hostreq` wrote a SQLite database through a `WebAccessFS` and OPFS was
// still empty ten seconds later.
//
// So this persists for a guest that ENDS: `run()`, and any embedder that hands
// the event loop back between sessions. It does NOT persist a long-lived
// `spawn()`, and no amount of care here would — that one needs a store whose
// writes leave SYNCHRONOUSLY, which on OPFS means `createSyncAccessHandle()`
// (worker-only, exclusive per file) or a writer thread the store blocks on
// through a `SharedArrayBuffer`. Neither is this adapter.
// ---------------------------------------------------------------------------

/** The sync half a session needs the moment it starts, before anything is awaited. */
const REQUIRED_METHODS = [
  'statSync', 'readdirSync', 'createFileSync', 'mkdirSync', 'rmdirSync', 'unlinkSync',
  'renameSync', 'readSync', 'writeSync', 'touchSync',
];

/** The sync methods that leave a write-back queued behind them. */
const QUEUEING_METHODS = [
  'renameSync', 'createFileSync', 'unlinkSync', 'rmdirSync', 'mkdirSync', 'linkSync',
  'writeSync', 'touchSync',
];

/**
 * Of those, the ones the backend cannot do against an index entry alone —
 * every one of them ends in `remove()` or a read of the real file. See the
 * `hollow` set in `persistentFs`.
 */
const NEEDS_A_REAL_FILE = new Set(['unlinkSync', 'renameSync', 'linkSync', 'rmdirSync']);

const PREPARED = Symbol.for('wasi-sh.persistentFs');

/**
 * Prepare a persistent store for a session: hydrate it, and give the writes
 * behind it somewhere to report a failure.
 *
 * `backing` is any store in the contract's shape, which in practice means a
 * `@zenfs/core` filesystem — this repo takes ZenFS's shape and not ZenFS, so
 * nothing here imports it and `npm i wasi-sh` still installs exactly one thing.
 * The backend is the embedder's to choose:
 *
 * ```js
 * import { WebAccess } from '@zenfs/dom';
 * import { persistentFs } from 'wasi-sh/fs';
 *
 * const store = await persistentFs(await WebAccess.create({
 *   handle: await navigator.storage.getDirectory(),
 * }), { onError: (err) => console.error('it did not save:', err) });
 *
 * await run({ inline: true, fs: store, command: 'echo hi > /a.txt' });
 * await store.flush();          // and now it is on disk
 * ```
 *
 * **For a session that ENDS.** The write-back needs the event loop and a
 * running guest never gives it back, so a long-lived `spawn()` fills the cache
 * and nothing else — see the note over the definitions above, which says what
 * that one needs instead.
 *
 * Returns the SAME object rather than a wrapper, so a second guest of the store
 * still sees the class it was handed — phasm's `mountStore()` mounts a ZenFS
 * filesystem directly and wraps anything else, and a wrapper would cost a layer
 * for nothing.
 *
 * @param backing a store to prepare, async-backed or not
 * @param options.onError called with each write-back failure, as it is seen
 * @param options.commit awaited by `flush()` after `sync()` — the backend's own
 *   barrier, for a backend whose `sync()` is not one. See gap 4 above, and
 *   {@link indexedDbFlushPoint}. Without it, `flush()` over such a backend
 *   returns in no time and means nothing.
 * @returns backing, hydrated, with `flush()` attached
 */
export async function persistentFs(backing, options = {}) {
  if (!backing || typeof backing !== 'object') {
    throw new Error('persistentFs: expected a store, got ' + (backing === null ? 'null' : typeof backing));
  }
  const missing = REQUIRED_METHODS.filter((name) => typeof backing[name] !== 'function');
  if (missing.length) {
    throw new Error(
      `persistentFs: this is not a store — it is missing ${missing.join(', ')}. The shape is `
      + "ZenFS's synchronous `FileSystem` (see wasi-sh/fs); an ASYNC-only filesystem cannot be one, "
      + 'because the guest is a wasm frame below every call and there is nothing to await into.'
    );
  }

  // Hydration first, and reported by name: `ready()` rejecting is a permission
  // that was not granted or a directory that went away, and the message the
  // backend throws says nothing about when it was being asked.
  if (typeof backing.ready === 'function') {
    try { await backing.ready(); }
    catch (err) {
      throw new Error(`persistentFs: the store could not be hydrated: ${(err && err.message) || err}`, { cause: err });
    }
  }

  // Preparing one store twice is not reachable through the documented shape,
  // and the guard is a trap laid for the next edit rather than a bug that has
  // fired: a second pass would stack a wrapper per call and report every
  // failure twice. Re-hydrating above is free and stays outside it, since that
  // is the half a caller might legitimately repeat.
  if (backing[PREPARED]) return backing;
  Object.defineProperty(backing, PREPARED, { value: true, enumerable: false, configurable: true });

  // The latch. A failure is reported to `onError` the moment it is seen — the
  // only timely report there is — and held for the next syncSync()/flush(), so
  // a caller that reads neither still gets it on the shim's own flush path.
  // Raising CLEARS it: repeating one stale error at every later exit would bury
  // the next real one under it.
  let latched = null;
  const { onError, commit } = options;
  if (commit !== undefined && typeof commit !== 'function') {
    throw new TypeError('persistentFs: `commit` is a function returning a promise, or nothing');
  }
  const reported = new WeakSet();
  const record = (err) => {
    // NOT a write failure, and on one engine it is every write. `@zenfs/core`'s
    // Async mixin re-applies each completed async op to its sync cache unless
    // it recognises the call as its own — and it recognises it by STRING
    // MATCHING A V8 STACK TRACE (`at <computed> [as write]`). SpiderMonkey
    // formats frames as `name@url`, so on Firefox the guard never fires: every
    // queued op is applied to the cache a second time, and `createFile` and
    // `mkdir` then throw EEXIST against what they just made, decorated with
    // ' (Out of sync!)'.
    //
    // Tolerated rather than reported, and the reason is structural rather than
    // hopeful: the wrapper does `await originalMethod(...)` FIRST and only then
    // touches the cache, so by the time this can throw **the bytes are already
    // on the backing store**. The cache is right too — this side applied it
    // synchronously before queueing. So there is nothing to report and nothing
    // to fix; passing it on latches a phantom failure that stops the whole
    // session at its next write, which is exactly what it did.
    //
    // ZENFS.md finding 9 — recorded, not filed; nothing on that list is filed
    // until the demo that justifies it is public. Drop this the day the guard
    // stops reading stack traces.
    if (err && typeof err.message === 'string' && err.message.endsWith('(Out of sync!)')) return;
    // The queue is one promise chained with `finally`, so ONE failure rejects
    // every link after it — a second look at the chain sees the same error
    // again, for ever. Report each object once and the count means something.
    if (err && typeof err === 'object') {
      if (reported.has(err)) return;
      reported.add(err);
    }
    // Which write it was comes from the error or not at all: watching the
    // queue costs the call site, and inventing one would name the wrong file.
    const at = err && err.path ? ` (${err.path})` : '';
    const wrapped = new Error(`persistentFs: a write did not reach the store${at}: ${(err && err.message) || err}`, { cause: err });
    if (err && err.code !== undefined) { wrapped.code = err.code; wrapped.errno = err.errno; }
    latched = latched || wrapped;
    if (onError) { try { onError(wrapped); } catch { /* a reporter that throws must not take the queue with it */ } }
  };
  const raise = () => { const err = latched; latched = null; if (err) throw err; };

  // Watch the write-back queue. `_promise` is the ONE private thing this
  // adapter reads, and it is read rather than replaced, because there is no
  // public way to see a failure: `sync()` is the only verb that awaits the
  // queue and it does so with `.catch(() => {})`.
  //
  // The queue is watched instead of the async METHODS being wrapped, and that
  // is not a style choice — it was measured. The mixin detects its own
  // recursion by reading the call stack for `<computed> [as write]`, which is
  // the name of the slot it patched; taking that slot moves the marker onto the
  // wrapper, the guard stops firing, and the write is applied to the cache a
  // second time. `mkdir` then fails EEXIST against a directory it just made.
  let watched = null;
  const watch = () => {
    const queue = backing._promise;
    if (!queue || typeof queue.catch !== 'function' || queue === watched) return;
    watched = queue;
    queue.catch(record);
  };

  // Files the backend has an INDEX ENTRY for and no file behind.
  //
  // `IndexFS.mkdir` calls `this._mkdir?.()` and `IndexFS.createFile` calls
  // nothing — there is no `_createFile` hook for a backend to implement — so
  // an index-backed async store materialises a directory and does not
  // materialise an empty file. `@zenfs/dom`'s `WebAccessFS` creates the OPFS
  // entry lazily, inside `write()`, so a file nothing ever writes to lives in
  // the index and the sync cache and nowhere a reload can find it.
  //
  // Two things follow, and both were seen in a browser:
  //
  //   * `touch a` at a prompt does not survive the tab. Nothing wrote the
  //     file, so OPFS never got one, and the next hydrate reads a directory it
  //     is not in.
  //   * `rm a` FAILS THE STORE. `remove()` is `removeEntry()` on a name the
  //     directory has never had — NotFoundError — and `IndexFS.rename` removes
  //     the source too, so `mv` is the same call. That failure latches here and
  //     the guest raises it at its next write, so `touch a; rm a` leaves every
  //     later `mkdir` an I/O error for the rest of the session.
  //
  // The fix is to write the file once with nothing in it, which is the
  // smallest call that makes the backend produce a handle. LAZILY, at the
  // points that need the file to be real: the ordinary shape is a create with
  // a write right behind it — that is every file of a seeded project — and
  // materialising eagerly would put a second write-back on each of them for a
  // tree where none was needed.
  //
  // ZENFS.md finding 10. Drop this the day `createFile` reaches the backend.
  const hollow = new Set();
  const materialize = (path) => {
    if (!hollow.delete(path)) return;
    // Through `backing.writeSync` rather than the captured original, so the
    // wrapper below still sees it and the queue is still watched.
    try { backing.writeSync(path, EMPTY, 0); }
    catch (err) { record(err); }
  };
  const materializeUnder = (root) => {
    if (!hollow.size) return;
    if (hollow.has(root)) { materialize(root); return; }
    for (const path of [...hollow]) if (path.startsWith(`${root}/`)) materialize(path);
  };
  const materializeAll = () => { for (const path of [...hollow]) materialize(path); };

  // A store with nothing asynchronous behind it queues nothing, so there is
  // nothing to watch and its writes throw from the call itself. Wrapping every
  // method to watch a queue that will never exist is pure cost, so don't — and
  // a synchronous backend has no hollow files either, since its `createFile`
  // IS the write.
  if (backing._promise && typeof backing._promise.catch === 'function') {
    for (const method of QUEUEING_METHODS) {
      const original = backing[method];
      if (typeof original !== 'function') continue;
      // Named deliberately, and NOT `<name>Sync`: the mixin's recursion guard
      // also matches a bare `writeSync ` anywhere in the stack, so a wrapper
      // called `persistentFs__writeSync` would make it fire where it must not.
      const named = `persistentFs__after_${method.slice(0, -4)}`;
      backing[method] = {
        [named]: (...args) => {
          // Anything that asks the backend to touch the FILE, rather than the
          // index in front of it, gets the hollow ones under its path written
          // out first. `rmdirSync` is on the list for completeness: a store
          // that refuses a non-empty rmdir can never reach it, and one that
          // allows it would otherwise leave a hollow entry under a directory
          // that is gone.
          //
          // BOTH ends of a rename, because `IndexFS.rename` removes the
          // destination as well when a name is already there —
          // `if (this.index.has(to)) await this.remove(to)` — so renaming ONTO
          // an empty file is the same NotFoundError as removing one.
          if (NEEDS_A_REAL_FILE.has(method)) {
            materializeUnder(String(args[0]));
            if (method === 'renameSync') materializeUnder(String(args[1]));
          }
          try {
            const result = original.apply(backing, args);
            // Only on the way OUT, so a create the cache refused is not
            // remembered as a file needing a write.
            if (method === 'createFileSync') hollow.add(String(args[0]));
            else if (method === 'writeSync') hollow.delete(String(args[0]));
            return result;
          } finally { watch(); }
        },
      }[named];
    }
    watch();
  }

  /**
   * Wait for every write so far to reach the backing store, and raise the
   * first that did not.
   *
   * This is the verb `syncSync()` would be if anything synchronous could await
   * OPFS. Call it where the answer is worth having — before a tab closes,
   * around a checkpoint — not per write: the queue drains on its own, and each
   * await costs a round trip through the backend.
   *
   * **`sync()` alone is not a flush point on every backend**, which is gap 4
   * above and the reason `options.commit` exists. Where one is supplied it is
   * awaited HERE, after `sync()` and before the failures are raised, so that a
   * caller who is given a `flush` can go on believing the one thing its name
   * says.
   */
  Object.defineProperty(backing, 'flush', {
    value: async function flush() {
      // Before the sync, not after: materializing QUEUES a write, and this
      // call's whole promise is that the queue is empty when it returns.
      materializeAll();
      if (typeof backing.sync === 'function') await backing.sync();
      if (commit) {
        // A backend-supplied barrier, and its failure is a failed write like
        // any other: reported through the same latch, so an embedder that only
        // reads `onError` still hears about it.
        try { await commit(); }
        catch (err) { record(err); }
      }
      watch();
      // One turn, so a rejection the line above only just attached to has been
      // delivered. `sync()` swallows it, so without this the first flush after
      // a failure reports nothing and the second reports it.
      await Promise.resolve();
      raise();
    },
    writable: true, configurable: true, enumerable: false,
  });

  // The shim calls this at every proc_exit and reports a throw as data loss on
  // stderr, which is the right treatment and the only one available: it cannot
  // wait for the backing store, so what it reports is what has ALREADY failed.
  // The cache sync underneath stays, because a backend that is not async-backed
  // has a real one to do.
  const syncSync = backing.syncSync;
  backing.syncSync = function persistentFs__flushPoint() {
    materializeAll();
    if (typeof syncSync === 'function') syncSync.call(backing);
    raise();
  };

  return backing;
}

/**
 * A `commit` for a store kept in IndexedDB — gap 4's barrier, built out of the
 * one guarantee IndexedDB makes about ordering and nothing else.
 *
 * **The guarantee.** Transactions whose scopes overlap and of which one is
 * `readwrite` never run concurrently: they run in the order they were CREATED,
 * per database, across every connection to it. So a `readonly` transaction
 * created now cannot complete until every `readwrite` transaction created
 * before it has committed — which makes waiting for one a way of waiting for
 * all of them, without knowing what they were or who issued them.
 *
 * That is the whole of it, and it is why this reaches for no ZenFS internal:
 * it needs the database's name and the object store's, both of which the
 * embedder already chose. It works for any writer of that database, including
 * one that is not this process's.
 *
 * ```js
 * const store = await persistentFs(await IndexedDB.create({ storeName: 'app@1' }), {
 *   commit: indexedDbFlushPoint({ database: 'app@1' }),
 * });
 * ```
 *
 * **It never creates anything.** `indexedDB.open(name)` with no version CREATES
 * an empty database when the name is unknown — and an empty one with no object
 * store in it is what a store opened over it then fails on. So this refuses a
 * database that is not there rather than making one, which is also the honest
 * answer: there is nothing to have committed.
 *
 * The connection is kept, because one open per flush is a round trip the
 * barrier is trying to be cheaper than — and closed on `versionchange`, so
 * holding it never blocks somebody else's `deleteDatabase`.
 *
 * @param options.database the IndexedDB database name
 * @param options.store the object store within it (defaults to the database name,
 *   which is what `@zenfs/dom`'s `IndexedDB` backend does)
 * @param options.factory an `IDBFactory` (defaults to `globalThis.indexedDB`)
 * @returns an async function to hand to `persistentFs`'s `commit`
 */
export function indexedDbFlushPoint(options = {}) {
  const { database, factory = globalThis.indexedDB } = options;
  const store = options.store || database;
  if (typeof database !== 'string' || !database) {
    throw new TypeError('indexedDbFlushPoint: needs { database }');
  }
  if (!factory) throw new TypeError('indexedDbFlushPoint: there is no IndexedDB here');

  // The CONNECTION PROMISE rather than the connection, which is not a
  // stylistic difference: the barrier is awaited once per drained batch and an
  // embedder is free to call `flush()` beside the drain, so two callers can be
  // inside `connect()` at once. Memoizing the resolved value lets both of them
  // past the guard and opens two connections, of which one is then held by
  // nothing and blocks the next `deleteDatabase` — which is the one thing a
  // page with a damaged store has left to try. Memoizing the promise is what
  // makes the second caller wait for the first one's answer.
  let opening = null;
  // ONE error object for "there is no such database", reused. A store whose
  // database has been deleted under it — an eviction, or somebody clearing site
  // data — fails every write from then on, and this barrier fails with them; a
  // fresh Error each time would be reported on every flush for the rest of the
  // session, because `persistentFs` dedupes by identity. Said once is right:
  // the writes underneath are raising their own failures beside it.
  let gone = null;
  const forget = () => { opening = null; };
  const connect = () => {
    if (opening) return opening;
    opening = (async () => {
      const known = typeof factory.databases === 'function'
        ? (await factory.databases()).some((one) => one.name === database)
        : true;   // an engine too old to list them; the upgrade guard below covers it
      return new Promise((resolve, reject) => {
        const request = factory.open(database);
        // The one case that must not be allowed to proceed: an upgrade means
        // the database was not there, and going on would leave an empty one
        // behind for the next `IndexedDB.create()` to fail on. Aborted, and
        // reported as what it MEANS rather than as what the abort says —
        // "Version change transaction was aborted in upgradeneeded event
        // handler" is this function's own plumbing talking.
        request.onupgradeneeded = () => {
          gone = gone || new Error(`indexedDbFlushPoint: '${database}' is no longer there`);
          request.transaction.abort();
          reject(gone);
        };
        request.onsuccess = () => {
          const db = request.result;
          if (!known || !db.objectStoreNames.contains(store)) {
            db.close();
            gone = gone || new Error(`indexedDbFlushPoint: there is no '${store}' in '${database}' to commit`);
            reject(gone);
            return;
          }
          // So that a delete from anywhere is never blocked by this connection.
          db.onversionchange = () => { db.close(); forget(); };
          db.onclose = forget;
          resolve(db);
        };
        request.onerror = () => reject(request.error || new Error('indexedDbFlushPoint: could not open the database'));
        request.onblocked = () => reject(new Error('indexedDbFlushPoint: the database is blocked'));
      });
    })().catch((err) => { forget(); throw err; });
    return opening;
  };

  return async function indexedDbCommit() {
    const db = await connect();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('indexedDbFlushPoint: the barrier was aborted'));
      // One request, because a transaction with nothing in it is allowed to be
      // optimised away — and the CHEAPEST one, because this runs per drained
      // batch: a key cursor nobody advances reads one key, where `count()` is
      // free to walk the store.
      tx.objectStore(store).openKeyCursor();
    });
  };
}

// ---------------------------------------------------------------------------
// A store that can be written from INSIDE a running guest.
//
// `persistentFs` above is hydrate-and-flush, and law 1 puts a ceiling on it:
// the write-back is a promise chain, promises need the event loop, and a live
// session is one synchronous `_start()` frame parked in `Atomics.wait`. So it
// persists a session that ENDS. A dev environment's session never does — the
// shell sits on `/dev/hostreq` for the life of the tab — and behind one, every
// write reaches the cache and nothing else. Measured, not assumed: a shell
// parked on `/dev/hostreq` wrote a SQLite database through a `WebAccessFS` and
// OPFS was still empty ten seconds later.
//
// What that needs is a store whose writes LEAVE synchronously. They cannot
// *land* synchronously — no browser API writes to a disk without awaiting —
// but they can leave the guest's thread, and a second thread whose event loop
// is free can land them. That is what these two are:
//
//   journalFs(...)      the store the session runs on. Reads come out of a
//                       synchronous cache; every mutation is applied to the
//                       cache and then APPENDED, synchronously, to a journal
//                       in a SharedArrayBuffer. It never awaits and never
//                       blocks, except for back-pressure when the journal is
//                       full and at syncSync().
//   journalWriter(...)  runs on another thread, owns the backing store, and
//                       replays the journal into it. It parks in
//                       `Atomics.waitAsync`, NOT `Atomics.wait`, which is the
//                       whole trick: the wait is a promise, so the event loop
//                       the backend needs stays free.
//
// This is the stdin ring aimed the other way — the same monotonic head/tail
// and the same seq wakeup word — with the two roles swapped: here the producer
// is the one on a worker (so it may block) and the consumer is the one that
// must not.
//
// ONE HOLDER OF THE BACKEND, and that is deliberate. The writer thread is the
// only thing that touches it; the guest's side never opens it at all. Two
// holders of one backing image is the shape that corrupts a
// `@zenfs/core` SingleBuffer (see MOAR §5), and a cache that is authoritative
// for reads has nothing to race with. The cost is stated where it bites: a
// change made to the backend by somebody else — another tab, the user's file
// manager — is invisible to a session already running.
// ---------------------------------------------------------------------------

// Header words, then the error region, then the journal itself.
const J_HEAD = 0;      // monotonic bytes appended, written by the store
const J_TAIL = 1;      // monotonic bytes APPLIED, written by the writer
const J_SEQ = 2;       // wakeup sequence, bumped by both sides
const J_ERR_SEQ = 3;   // bumped once per failure the writer records
const J_ERR_LEN = 4;   // bytes of the message below
const J_STATE = 5;     // 0 unstarted, 1 draining, 2 stopped
const J_WORDS = 8;
const J_HEADER_BYTES = J_WORDS * 4;
// A message, not a log: enough for a quota error with a path, truncated past
// that. The reason travels because a store that fails without one is the
// failure persistentFs exists to stop happening twice.
const J_ERR_BYTES = 512;
const J_PREFIX = J_HEADER_BYTES + J_ERR_BYTES;

const J_UNSTARTED = 0, J_DRAINING = 1, J_STOPPED = 2;

// Below this a single ordinary write does not fit beside its header and every
// write would be chunked into uselessness. 64 KiB is the stdin ring's default
// and the same reasoning applies.
const J_MIN_BYTES = 65536;
const J_DEFAULT_BYTES = 1 << 20;

const J_DEC = new TextDecoder();

/**
 * Create the journal's SharedArrayBuffer. Sized for `bytes` of journal
 * capacity — the header and the error region are on top, so `bufferSize` means
 * what it says.
 */
export function createJournal(bytes = J_DEFAULT_BYTES) {
  const size = Math.max(J_MIN_BYTES, bytes | 0);
  return new SharedArrayBuffer(J_PREFIX + size);
}

// head and tail are monotonic byte counters in Int32 cells, so after 2 GiB
// through the journal they wrap — and a dev environment's session is exactly
// the one that runs long enough to. Two's complement makes that harmless
// PROVIDED every comparison goes through the difference: `(a - b) | 0` is the
// real distance whenever it is under 2 GiB, which the journal's capacity
// guarantees, while `a >= b` on the raw values is wrong the moment one side
// has wrapped and the other has not. Nothing here compares them directly.
const jBehind = (a, b) => (a - b) | 0;
// And the same wrap makes a raw `%` negative, which would index backwards
// into the buffer.
const jIndex = (position, capacity) => ((position % capacity) + capacity) % capacity;

/** The one wakeup, used by both sides: bump seq, notify everybody on it. */
function jWake(ctrl) {
  Atomics.add(ctrl, J_SEQ, 1);
  Atomics.notify(ctrl, J_SEQ);
}

/** The one refusal a stopped writer earns, from either side of the wait. */
const jStopped = () => jError('EIO', 'journalFs: the journal writer has stopped, so nothing more can be persisted');

function jError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.errno = ERRNO[code];
  return err;
}

/**
 * Walk a store into a plain, structured-cloneable snapshot.
 *
 * Depth-first and parents-first, so applying it back needs no sorting. Hard
 * links do not survive — a snapshot is keyed by path, so two names for one
 * inode come back as two files — which is worth knowing and is not worth an
 * inode table for: nothing in a shell session makes one but `ln`.
 */
function snapshotStore(store, path = '/', out = []) {
  const st = store.statSync(path);
  const entry = {
    path, mode: st.mode, uid: st.uid, gid: st.gid,
    atimeMs: st.atimeMs, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs,
  };
  if (isDir(st.mode)) {
    out.push(entry);
    for (const name of store.readdirSync(path)) {
      snapshotStore(store, path === '/' ? `/${name}` : `${path}/${name}`, out);
    }
  } else if (isFile(st.mode)) {
    const data = new Uint8Array(st.size);
    if (st.size) store.readSync(path, data, 0, st.size);
    entry.data = data;
    out.push(entry);
  }
  // Anything else — a device node somebody put in a backing store — is left
  // out rather than guessed at: the shim owns /dev and would shadow it anyway.
  return out;
}

/** Replay a snapshot into a fresh cache. */
function applySnapshot(cache, snapshot) {
  for (const entry of snapshot) {
    const { path, data } = entry;
    const options = { mode: entry.mode & 0o7777, uid: entry.uid, gid: entry.gid };
    if (data === undefined) {
      // '/' is there by construction and '/tmp' is there by MemoryFs's
      // constructor, so a snapshot carrying either is applied as metadata
      // rather than as a second mkdir.
      if (path !== '/') { try { cache.mkdirSync(path, options); } catch (err) { if (err.code !== 'EEXIST') throw err; } }
    } else {
      cache.createFileSync(path, options);
      if (data.length) cache.writeSync(path, data, 0);
    }
    cache.touchSync(path, {
      mode: entry.mode & 0o7777, uid: entry.uid, gid: entry.gid,
      atimeMs: entry.atimeMs, mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
    });
  }
}

// A journal frame is a length-prefixed pair: a JSON header naming the call and
// its arguments, and the raw bytes of a write beside it rather than inside it.
// Base64 in the JSON would cost 33% of every byte a guest writes, and this
// channel is not line-oriented the way /dev/host is — a frame carries its own
// length, so a payload with a newline in it is not a second frame.
function encodeFrame(header, payload) {
  const json = ENC.encode(JSON.stringify(header));
  const frame = new Uint8Array(8 + json.length + (payload ? payload.length : 0));
  new DataView(frame.buffer).setUint32(0, json.length, true);
  new DataView(frame.buffer).setUint32(4, payload ? payload.length : 0, true);
  frame.set(json, 8);
  if (payload) frame.set(payload, 8 + json.length);
  return frame;
}

/**
 * The store a running session writes through: a synchronous cache, plus a
 * journal of every mutation appended to shared memory for another thread to
 * apply.
 *
 * `sab` is the buffer a {@link journalWriter} created and posted, and
 * `snapshot` is the tree it read out of the backing store — so the session
 * starts on what is really there, and the writer stays the only holder of the
 * backend.
 *
 * ```js
 * // in the guest's worker. serve() is called SYNCHRONOUSLY — it has to win
 * // the startup message — so the wait for the writer's handover happens
 * // inside fs(), which is awaited before the shell is built.
 * let handOver;
 * const handed = new Promise((resolve) => { handOver = resolve; });
 * self.addEventListener('message', (e) => {
 *   if (e.data?.type === 'store') handOver(journalFs(e.data.sab, e.data.snapshot));
 * });
 * serve({ fs: () => handed });
 * ```
 *
 * WORKER-ONLY, and it says so rather than failing later: appending under
 * back-pressure and `syncSync()` both park in `Atomics.wait`, which the main
 * thread refuses. That is the same rule the shell itself lives under.
 *
 * @param sab the journal buffer from `journalWriter().sab`
 * @param snapshot the tree from `journalWriter().snapshot`
 * @param options.timeout ms to wait for the writer before giving up (default 10000)
 */
export function journalFs(sab, snapshot = [], options = {}) {
  return new JournalFs(sab, snapshot, options);
}

export class JournalFs {
  #ctrl; #data; #cap; #timeout; #seenErr;

  constructor(sab, snapshot = [], options = {}) {
    if (!(sab instanceof SharedArrayBuffer)) {
      throw new Error(
        'journalFs: expected the SharedArrayBuffer from journalWriter().sab. The journal is '
        + 'shared memory by construction — a store whose writes leave the thread synchronously '
        + 'has nowhere else to put them.'
      );
    }
    this.#ctrl = new Int32Array(sab, 0, J_WORDS);
    this.#data = new Uint8Array(sab, J_PREFIX);
    this.#cap = sab.byteLength - J_PREFIX;
    this.#timeout = options.timeout ?? 10000;
    // The failure count at construction, not zero: a writer that failed while
    // hydrating has already recorded one, and starting "unseen" would raise it
    // at the first write as though that write had caused it.
    this.#seenErr = Atomics.load(this.#ctrl, J_ERR_SEQ);

    // Probe rather than sniff for a worker. `Atomics.wait` throws on a thread
    // that may not block whatever the value is, so a mismatched compare — which
    // returns 'not-equal' without waiting anywhere it is allowed — tells us
    // exactly what we need to know and costs nothing.
    try { Atomics.wait(this.#ctrl, J_SEQ, Atomics.load(this.#ctrl, J_SEQ) + 1, 0); }
    catch {
      throw new Error(
        'journalFs: this thread may not block, so it cannot be the one a guest runs on. '
        + 'The store parks in Atomics.wait for back-pressure and at syncSync(), which the main '
        + 'thread refuses — build it inside the worker, from serve({ fs }).'
      );
    }

    // A writer that has not started, or has stopped, cannot be told anything —
    // and a store built against one would take writes into a cache nothing
    // drains, which is exactly the silent half-persistence this replaces. Said
    // here, once, rather than as a surprise at the first write.
    const state = Atomics.load(this.#ctrl, J_STATE);
    if (state !== J_DRAINING) {
      throw new Error(
        `journalFs: the journal writer is ${state === J_STOPPED ? 'stopped' : 'not running'}, so nothing `
        + 'written here would ever be persisted. Build the store from the buffer a live journalWriter() '
        + 'handed over, and keep that writer running for as long as the session.'
      );
    }

    this.cache = new MemoryFs();
    applySnapshot(this.cache, snapshot);
    // MemoryFs makes /tmp and a backing store that has never seen a shell has
    // not, so the two would disagree from the first frame — every op under
    // /tmp arriving at a directory the writer does not have. One rule here,
    // and it is that everything the cache holds is journaled: seed the mkdir
    // rather than making /tmp the one path that is exempt.
    if (!snapshot.some((entry) => entry.path === '/tmp')) {
      const frame = encodeFrame({ op: 'mkdirSync', path: '/tmp', options: { mode: DEFAULT_DIR_MODE, uid: 0, gid: 0 } });
      this.#reserve(frame.length);
      this.#commit(frame);
    }
  }

  // ---- the journal ----

  #state() { return Atomics.load(this.#ctrl, J_STATE); }

  // Raise what the writer reported, at most once per failure. The message
  // travels through the buffer rather than being reconstructed here: a store
  // that says "a write did not reach the backend" and cannot say which one or
  // why is the failure `persistentFs` was built to stop being silent.
  #raise() {
    const seq = Atomics.load(this.#ctrl, J_ERR_SEQ);
    if (seq === this.#seenErr) return;
    this.#seenErr = seq;
    const len = Math.min(Atomics.load(this.#ctrl, J_ERR_LEN), J_ERR_BYTES);
    // `.slice()` matters, and it is not a copy for tidiness. The error region
    // is inside the journal's SharedArrayBuffer, and `TextDecoder.decode()`
    // REFUSES a view backed by one in Firefox — Chrome allows it, which is why
    // this only ever failed on one browser and only on the path that reports a
    // failure. The thrown TypeError then replaced the EIO this exists to
    // deliver, so the guest was told the wrong thing at exactly the moment it
    // most needed the right one.
    const message = len
      ? J_DEC.decode(new Uint8Array(this.#ctrl.buffer, J_HEADER_BYTES, len).slice())
      : 'the writer did not say why';
    throw jError('EIO', `journalFs: a write did not reach the backing store: ${message}`);
  }

  // Wait until `cond()`, parking on seq. Returns false when the deadline
  // passed — a stopped or wedged writer must not become an infinite hang
  // inside a guest's `write()`.
  #waitFor(cond) {
    const deadline = Date.now() + this.#timeout;
    for (;;) {
      const seq = Atomics.load(this.#ctrl, J_SEQ);
      if (cond()) return true;
      const left = deadline - Date.now();
      if (left <= 0) return cond();
      Atomics.wait(this.#ctrl, J_SEQ, seq, Math.min(left, 1000));
    }
  }

  #free() {
    return this.#cap - jBehind(Atomics.load(this.#ctrl, J_HEAD), Atomics.load(this.#ctrl, J_TAIL));
  }

  // Reserving and committing are two steps so that a journal which cannot take
  // the frame refuses BEFORE the cache has been changed. One step, and a
  // stopped writer left the guest holding a file the backend will never hear
  // about — the two halves diverging silently, which is the failure this whole
  // seam exists to make impossible. Nothing else produces into this journal,
  // so space that is free when reserved is still free when committed.
  #reserve(length) {
    if (length > this.#cap) {
      // Unreachable for a write, which is chunked to fit; reachable for a path
      // long enough that its header alone overflows, which is a store failure
      // with a name of its own.
      throw jError('ENAMETOOLONG', `journalFs: this operation does not fit in a ${this.#cap}-byte journal; raise bufferSize`);
    }
    if (this.#state() === J_STOPPED) throw jStopped();
    // The wait ends on EITHER answer, and the second one is the whole point:
    // room arriving means go, and the writer stopping means it never will. The
    // check above only covers a writer that was already gone when this was
    // called — a writer that dies while this is parked is invisible to a
    // condition that asks about space, so every write after it sat out the full
    // timeout for a drain that was over. Ten seconds each, from a shell.
    // syncSync() has always short-circuited on the same state; these two agree
    // now.
    if (this.#free() < length
      && !this.#waitFor(() => this.#free() >= length || this.#state() === J_STOPPED)) {
      throw jError('EIO',
        `journalFs: the journal writer did not drain within ${this.#timeout}ms — `
        + `${length} bytes to append, ${this.#free()} free. It is wedged, or on a thread `
        + 'whose event loop is blocked, which is the one thing it may not be.');
    }
    // Asked again rather than inferred from the wait: it may have ended on
    // either condition, and a writer that has stopped cannot persist this frame
    // whether or not there is now room for it.
    if (this.#state() === J_STOPPED) throw jStopped();
  }

  #commit(frame) {
    const head = Atomics.load(this.#ctrl, J_HEAD);
    const at = jIndex(head, this.#cap);
    const first = Math.min(frame.length, this.#cap - at);
    this.#data.set(frame.subarray(0, first), at);
    if (first < frame.length) this.#data.set(frame.subarray(first), 0);
    Atomics.store(this.#ctrl, J_HEAD, (head + frame.length) | 0);
    jWake(this.#ctrl);
  }

  // Every mutation goes through here, and the ORDER is the contract: room is
  // taken first so a journal that cannot accept the frame refuses before
  // anything has changed, and the CACHE decides second — so a call the cache
  // refuses (EEXIST, ENOENT, EISDIR) is never committed, and the writer only
  // ever replays operations that already succeeded against a store in the same
  // state it is in.
  #mutate(apply, header, payload) {
    this.#raise();
    const frame = encodeFrame(header, payload);
    this.#reserve(frame.length);
    const result = apply();
    this.#commit(frame);
    return result;
  }

  // ---- the contract: reads are the cache, unchanged ----

  statSync(path) { return this.cache.statSync(path); }
  readdirSync(path) { return this.cache.readdirSync(path); }
  readSync(path, buffer, start, end) { return this.cache.readSync(path, buffer, start, end); }

  // ---- the contract: writes are the cache, and then the journal ----

  createFileSync(path, options = {}) {
    return this.#mutate(() => this.cache.createFileSync(path, options), { op: 'createFileSync', path, options });
  }

  mkdirSync(path, options = {}) {
    return this.#mutate(() => this.cache.mkdirSync(path, options), { op: 'mkdirSync', path, options });
  }

  rmdirSync(path) { return this.#mutate(() => this.cache.rmdirSync(path), { op: 'rmdirSync', path }); }
  unlinkSync(path) { return this.#mutate(() => this.cache.unlinkSync(path), { op: 'unlinkSync', path }); }
  renameSync(from, to) { return this.#mutate(() => this.cache.renameSync(from, to), { op: 'renameSync', from, to }); }
  linkSync(target, link) { return this.#mutate(() => this.cache.linkSync(target, link), { op: 'linkSync', target, link }); }
  touchSync(path, metadata = {}) { return this.#mutate(() => this.cache.touchSync(path, metadata), { op: 'touchSync', path, metadata }); }

  writeSync(path, buffer, offset) {
    this.#raise();
    // A write bigger than the journal is split by OFFSET, which the contract
    // already makes safe: writes are positional, so the pieces are ordinary
    // writes that happen to be adjacent, applied in order. Nothing else in the
    // contract can exceed the buffer, since only a write carries bytes. The
    // header is measured at the LAST offset the split will use, which is the
    // longest one it can print.
    const room = this.#cap - 8 - ENC.encode(JSON.stringify({ op: 'writeSync', path, offset: offset + buffer.length })).length;
    if (room <= 0) {
      throw jError('ENAMETOOLONG', `journalFs: '${path}' leaves no room for its own bytes in a ${this.#cap}-byte journal; raise bufferSize`);
    }
    const starts = [];
    for (let at = 0; at < buffer.length || at === 0; at += room) {
      starts.push(at);
      if (!buffer.length) break;
    }
    // Encoded one chunk at a time, never all of them: holding every frame
    // would cost a second copy of the whole write, and the writes this store
    // exists for are a project's, not a line's.
    const frameAt = (at) => encodeFrame({ op: 'writeSync', path, offset: offset + at },
      buffer.subarray(at, Math.min(at + room, buffer.length)));
    // Only the first frame is reserved before the cache changes. A split write
    // is several journal entries and the journal is smaller than the write by
    // definition, so the rest genuinely wait on the writer — a failure part way
    // through leaves the backend holding a PREFIX of the file and raises,
    // which is the honest outcome and the reason it raises rather than
    // returning.
    const first = frameAt(starts[0]);
    this.#reserve(first.length);
    this.cache.writeSync(path, buffer, offset);
    this.#commit(first);
    for (const at of starts.slice(1)) {
      const frame = frameAt(at);
      this.#reserve(frame.length);
      this.#commit(frame);
    }
  }

  /**
   * Block until everything appended so far has been APPLIED to the backing
   * store, and raise the first failure.
   *
   * The verb `persistentFs` could not have: the writer advances the tail only
   * after its own flush resolved, so tail === head means the bytes are on the
   * disk and not merely queued for it. This is what makes the shim's
   * `proc_exit` flush point tell the truth for a persistent store.
   */
  syncSync() {
    const head = Atomics.load(this.#ctrl, J_HEAD);
    const applied = () => jBehind(Atomics.load(this.#ctrl, J_TAIL), head) >= 0;
    const settled = this.#waitFor(() => applied() || this.#state() === J_STOPPED);
    this.#raise();
    if (!settled) {
      throw jError('EIO', `journalFs: the journal writer did not finish within ${this.#timeout}ms, so what is written is not known to have been saved`);
    }
    if (!applied()) {
      throw jError('EIO', 'journalFs: the journal writer stopped with writes still unapplied');
    }
  }
}

/**
 * Run the other half, on a thread whose event loop is free: own the backing
 * store, hand out a snapshot of it, and apply everything the guest journals.
 *
 * ```js
 * // in a worker of its own — NOT the one the shell runs in
 * import { WebAccess } from '@zenfs/dom';
 * import { journalWriter } from 'wasi-sh/fs';
 *
 * const writer = await journalWriter(
 *   await WebAccess.create({ handle: await navigator.storage.getDirectory() }),
 *   { onError: (err) => report(err) },
 * );
 * postMessage({ sab: writer.sab, snapshot: writer.snapshot });
 * ```
 *
 * It parks in `Atomics.waitAsync`, so the wait is a promise and the backend's
 * own promises still run — which is the entire difference between this and
 * putting `persistentFs` behind a live session. A thread that parked in
 * `Atomics.wait` here would reproduce law 1 exactly one thread further along.
 *
 * **`snapshot` takes hydration off the guest's critical path.** By default this
 * call hydrates the store and then walks it, because a snapshot has nowhere
 * else to come from — and the guest waits for all of it. A caller that can read
 * the tree faster than the backend hydrates hands the result over instead, and
 * only the drain waits:
 *
 * ```js
 * const root = await navigator.storage.getDirectory();
 * const writer = await journalWriter(
 *   WebAccess.create({ handle: root }),        // a promise: not awaited here
 *   { snapshot: await readTheTree(root), onError: (err) => report(err) },
 * );
 * postMessage({ sab: writer.sab, snapshot: writer.snapshot });
 * ```
 *
 * The snapshot must be what the backing store would have produced — the shape
 * `snapshotStore()` returns, parents before children — because it is what the
 * guest's cache starts as and what every later write is applied on top of. A
 * tree read at a different moment than the store was opened is the one way to
 * get this wrong.
 *
 * @param backing the store to persist into, or a promise of one
 * @param options.bufferSize journal capacity in bytes (default 1 MiB)
 * @param options.sab an existing journal buffer, when the page made it
 * @param options.snapshot the tree, when the caller has already read it
 * @param options.onError called with each failure, as it happens
 */
export async function journalWriter(backing, options = {}) {
  const sab = options.sab ?? createJournal(options.bufferSize);
  const ctrl = new Int32Array(sab, 0, J_WORDS);
  const data = new Uint8Array(sab, J_PREFIX);
  const cap = sab.byteLength - J_PREFIX;

  // The buffer is claimed HERE, before anything is awaited, and that ordering
  // is the whole of `snapshot` below. `journalFs` refuses a journal that is not
  // draining — rightly, since a store built against one takes writes nothing
  // will ever apply — so the claim has to be visible to the other thread from
  // the first synchronous moment, not after a hydrate that may take seconds.
  // The guard keeps meaning exactly what it says: THIS buffer has a live
  // writer. What it no longer implies is that the writer has finished opening.
  let running = true;
  Atomics.store(ctrl, J_STATE, J_DRAINING);

  // NO `onError` through to persistentFs, deliberately. It reports a failure as
  // it happens and `flush()` raises the same one straight after, and the drain
  // below flushes every batch — so passing it on made one failed write arrive
  // at the embedder twice. The flush is the timely report here.
  //
  // `backing` may be a promise, so that opening it is not on the caller's
  // critical path either: a backend that reads an index of its own costs about
  // what hydrating it does, and neither is worth the guest waiting on when the
  // caller already knows what the tree contains.
  let store = null;
  const preparing = Promise.resolve(backing)
    .then((resolved) => persistentFs(resolved))
    .then((prepared) => (store = prepared));

  let snapshot;
  if (options.snapshot === undefined) {
    // The default, and the only shape before this option existed: read the tree
    // out of the store that was just hydrated, and hand it over. Everything
    // below waits, because there is nothing else the snapshot could come from.
    try {
      await preparing;
      // Inside the try, because reading the tree is part of what this writer
      // promised to do: a store that hydrated and then threw on the walk would
      // otherwise leave a buffer advertising a live writer with no drain
      // behind it, which is the one state journalFs cannot detect.
      snapshot = snapshotStore(store);
    } catch (err) {
      // J_DRAINING is a claim this writer is now failing to honour. Withdraw it
      // rather than leaving a buffer that says a writer is live while the
      // rejection travels back to a caller who may not connect the two.
      Atomics.store(ctrl, J_STATE, J_STOPPED);
      jWake(ctrl);
      throw err;
    }
  } else {
    // The caller read the tree itself and hydration is no longer on the path to
    // a running guest — the drain waits for it instead, at the first frame it
    // has to apply. Worth 1.3 s of a 1.9 s cold boot for phasm's dev page,
    // where the tree is a Laravel `vendor/` and the backend is OPFS: one
    // parallel read of the directory produces the same snapshot in 591 ms that
    // hydrating a `WebAccessFS` to be walked takes 1,899 ms to produce.
    //
    // The cost is that a hydrate that FAILS is no longer this call rejecting.
    // It arrives where every other write-back failure does — `onError`, and the
    // error region the guest raises from at its next write — which is the same
    // report, later, rather than a different one.
    snapshot = options.snapshot;
  }

  // The failure the guest is told about, and the only channel it has: a
  // message in the buffer plus a count, so a store on the other thread can
  // raise the REASON rather than "something failed". Truncated to fit, since a
  // fixed region is what shared memory offers and a partial message beats a
  // generic one.
  const report = (err) => {
    const text = `${(err && err.message) || err}`;
    const bytes = ENC.encode(text).subarray(0, J_ERR_BYTES);
    new Uint8Array(sab, J_HEADER_BYTES, J_ERR_BYTES).set(bytes);
    Atomics.store(ctrl, J_ERR_LEN, bytes.length);
    Atomics.add(ctrl, J_ERR_SEQ, 1);
    if (options.onError) { try { options.onError(err); } catch { /* a reporter that throws must not take the drain with it */ } }
    jWake(ctrl);
  };

  // A frame may wrap the end of the journal, so bytes come out through here
  // rather than through a subarray the caller might assume is contiguous.
  const take = (from, length) => {
    const at = jIndex(from, cap);
    if (at + length <= cap) return data.slice(at, at + length);
    const out = new Uint8Array(length);
    out.set(data.subarray(at));
    out.set(data.subarray(0, length - (cap - at)), cap - at);
    return out;
  };

  // Resizing has to be done by CONTENT, not by metadata, and that is a
  // backend defect rather than a preference. `@zenfs/core`'s `IndexFS.touch`
  // updates the index inode and nothing else (2.6.3), so a truncate leaves the
  // real file its old length: within the session the cache agrees with itself,
  // and the next hydrate rebuilds the index from the file that is actually
  // there and hands back the OLD BYTES PAST THE NEW END. Measured through
  // OPFS, on the commonest write a shell makes — `echo x > file` leaves
  // `x` followed by whatever the file used to say, after a reload.
  //
  // So a resize is replayed as an exact rewrite. Removing and recreating is
  // safe HERE and nowhere else: this store is the writer's alone, no guest
  // holds a descriptor on it, and no inode of it is ever observed. The same
  // fix inside `persistentFs` would change an ino under a running shell.
  //
  // ZENFS.md finding 2. Drop this the day `touch` resizes the data.
  const applyResize = (path, metadata) => {
    const before = store.statSync(path);
    if (before.size === metadata.size) { store.touchSync(path, metadata); return; }
    const keep = Math.min(metadata.size, before.size);
    const bytes = new Uint8Array(metadata.size);      // a shorter file, or a zero hole
    if (keep) store.readSync(path, bytes.subarray(0, keep), 0, keep);
    store.unlinkSync(path);
    store.createFileSync(path, { mode: before.mode & 0o7777, uid: before.uid, gid: before.gid });
    if (bytes.length) store.writeSync(path, bytes, 0);
    store.touchSync(path, metadata);
  };

  const applyOne = (header, payload) => {
    switch (header.op) {
      case 'createFileSync': return void store.createFileSync(header.path, header.options);
      case 'mkdirSync': return void store.mkdirSync(header.path, header.options);
      case 'rmdirSync': return void store.rmdirSync(header.path);
      case 'unlinkSync': return void store.unlinkSync(header.path);
      case 'renameSync': return void store.renameSync(header.from, header.to);
      case 'linkSync': return void store.linkSync(header.target, header.link);
      case 'touchSync': return void (header.metadata && header.metadata.size !== undefined
        ? applyResize(header.path, header.metadata)
        : store.touchSync(header.path, header.metadata));
      case 'writeSync': return void store.writeSync(header.path, payload, header.offset);
      // Not reachable from the store above, and worth saying so out loud: a
      // frame nobody wrote means the two sides are different versions.
      default: throw new Error(`unknown journal operation '${header.op}'`);
    }
  };

  const drain = async () => {
    try {
      // Nothing can be applied before there is a store to apply it to. On the
      // default path this is already settled; on the deferred one it is what
      // the guest's first write ends up waiting behind, which is the right
      // place for the wait to land — it is the first moment the answer matters.
      await preparing;
      while (running) {
        const seq = Atomics.load(ctrl, J_SEQ);
        const head = Atomics.load(ctrl, J_HEAD);
        let tail = Atomics.load(ctrl, J_TAIL);
        if (jBehind(head, tail) <= 0) {
          await Atomics.waitAsync(ctrl, J_SEQ, seq, 1000).value;
          continue;
        }
        while (jBehind(head, tail) > 0) {
          const prefix = take(tail, 8);
          const view = new DataView(prefix.buffer, prefix.byteOffset);
          const jsonLen = view.getUint32(0, true), binLen = view.getUint32(4, true);
          const body = take(tail + 8, jsonLen + binLen);
          tail = (tail + 8 + jsonLen + binLen) | 0;
          // One bad operation must not end persistence for every later one: the
          // frame is spent either way, so it is reported and the drain carries
          // on. Stopping here would wedge the guest against a full journal for a
          // failure it may not even be able to act on.
          try {
            applyOne(JSON.parse(J_DEC.decode(body.subarray(0, jsonLen))), body.subarray(jsonLen));
          } catch (err) { report(err); }
        }
        // The flush comes BEFORE the tail moves, so a drained journal on the
        // other side means applied-and-flushed rather than merely dequeued.
        // That is what lets journalFs.syncSync() be a true flush point.
        //
        // **It is only as true as the store's own flush**, which gap 4 over
        // `persistentFs` says is not automatic: over a backend whose `sync()`
        // is an empty function this line returns without waiting for anything,
        // the tail moves over writes that have not landed, and `pending()` and
        // `idle()` below report a durability nobody has. A store prepared with
        // `persistentFs(backing, { commit })` is what makes this line mean what
        // it says.
        try { await store.flush(); }
        catch (err) { report(err); }
        Atomics.store(ctrl, J_TAIL, tail);
        jWake(ctrl);
      }
    } catch (err) {
      // Nothing above is expected to throw — every call that can is caught
      // where it is made. If one does anyway, the guest must learn it here:
      // a writer that died quietly leaves the store waiting out its timeout on
      // every single write, which reads as a filesystem that has gone slow
      // rather than one that has stopped saving.
      report(err);
    } finally {
      Atomics.store(ctrl, J_STATE, J_STOPPED);
      jWake(ctrl);
    }
  };

  const done = drain();

  return {
    sab,
    snapshot,
    /**
     * Resolves to the hydrated backing store. Always await this when a
     * `snapshot` was supplied — that is the whole point of supplying one.
     */
    ready: preparing,
    /**
     * The hydrated backing store, for a caller that already knows it is open.
     * A getter rather than a field because `snapshot` makes it legal for this
     * call to return before there is one, and a property that is silently
     * `null` for the first second of a session is a defect waiting to be
     * blamed on the store.
     */
    get store() {
      if (!store) {
        throw new Error(
          'journalWriter: the backing store is not open yet. That is what passing `snapshot` buys — '
          + 'the guest starts on the tree you already read while this hydrates behind it. Await '
          + '`ready` for the store itself.'
        );
      }
      return store;
    },
    /** Stop draining and settle once the loop has left. */
    async stop() { running = false; jWake(ctrl); await done; },
    /**
     * Bytes appended but not yet applied and flushed.
     *
     * `idle()` answers "is it safe yet"; this answers "how far off", so a
     * caller can say what it is waiting for instead of only that it is waiting.
     * Cheap enough to poll: two atomic loads and no wait.
     *
     * It moves in STEPS, not smoothly: the tail advances once per applied
     * batch, so a large append can read the same figure for the whole drain and
     * then go straight to zero. Good for "6.9 MB still to write", wrong for a
     * progress bar — which is a lesson learned by building the bar first.
     */
    pending() {
      const behind = jBehind(Atomics.load(ctrl, J_HEAD), Atomics.load(ctrl, J_TAIL));
      return behind > 0 ? behind : 0;
    },
    /** Resolves when everything appended so far has been applied and flushed. */
    async idle() {
      while (jBehind(Atomics.load(ctrl, J_HEAD), Atomics.load(ctrl, J_TAIL)) > 0 && Atomics.load(ctrl, J_STATE) !== J_STOPPED) {
        await Atomics.waitAsync(ctrl, J_SEQ, Atomics.load(ctrl, J_SEQ), 50).value;
      }
    },
  };
}
