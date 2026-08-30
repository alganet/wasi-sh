/** Linux errno numbers, as a store throws them. */
export const ERRNO: Record<string, number>;

/** An error carrying a store's failure: `.code` is the name, `.errno` the number. */
export interface FsError extends Error {
  code: string;
  errno: number;
  path?: string;
}

/** Build the error a store throws. */
export function fsError(code: string, path?: string): FsError;

export const S_IFMT: number;
export const S_IFDIR: number;
export const S_IFREG: number;
export const S_IFCHR: number;
export function isDir(mode: number): boolean;
export function isFile(mode: number): boolean;
export function isChar(mode: number): boolean;

/** Collapse `.` and `..`; the result is absolute and `..` clamps at root. */
export function normalize(path: string): string;

/** One node's metadata. The file type lives in `mode`, POSIX-style. */
export interface InodeLike {
  /** UNIQUE per node — busybox find/cp -r detect directory loops by dev:ino. */
  ino: number;
  nlink: number;
  size: number;
  /** Type bits (S_IFDIR/S_IFREG/S_IFCHR) plus permissions. */
  mode: number;
  uid: number;
  gid: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs?: number;
}

/**
 * What a node is created with. `uid`, `gid` and `mode` are REQUIRED, as they
 * are in ZenFS's `CreationOptions` — a store is entitled to record exactly
 * what it is handed, and one that did produced files with no permission bits,
 * unreadable to any guest sharing the store. `memoryFs` filling them in is a
 * courtesy; nothing may rely on it.
 */
export interface CreationOptions extends Partial<InodeLike> {
  uid: number;
  gid: number;
  /** Permission bits; the type bits are the store's to add. */
  mode: number;
}

/** What the shim creates with when nothing else says. */
export const DEFAULT_DIR_MODE: number;
export const DEFAULT_FILE_MODE: number;

/**
 * The store a WasiShim reads and writes through: path-addressed, synchronous,
 * in ZenFS's `FileSystem` shape.
 *
 * SYNCHRONOUS is structural, not a preference — the guest is a wasm stack
 * frame below every call, so there is nothing to await into.
 *
 * Offsets are arguments, never state: an open file description's shared `pos`
 * cell stays in the shim, where dup/dup2 already handle it.
 *
 * Failures throw an error carrying LINUX errno (`ENOENT` = 2), which is what
 * the ecosystem's stores throw; the shim translates to WASI's numbering.
 */
export interface FileSystem {
  statSync(path: string): InodeLike;
  /** Entry names, not paths. Throws ENOTDIR when `path` is a file. */
  readdirSync(path: string): string[];
  /** Throws EEXIST if it is there, ENOENT if the parent directory is not. */
  createFileSync(path: string, options: CreationOptions): InodeLike;
  mkdirSync(path: string, options: CreationOptions): InodeLike;
  /** Throws ENOTEMPTY unless the directory is empty. */
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  /** A second name for one node. May throw ENOSYS — the shim reports it as such. */
  linkSync(target: string, link: string): void;
  /** Read bytes [start, end) into `buffer` at offset 0. ENOENT if it is not there. */
  readSync(path: string, buffer: Uint8Array, start: number, end: number): void;
  /**
   * Write `buffer` at `offset`, extending the file (and zero-filling) as needed.
   *
   * Throws ENOENT for a path that does not exist, an empty buffer included:
   * this is the shim's only existence check on the write path, since nothing
   * but O_APPEND has a reason to stat first.
   */
  writeSync(path: string, buffer: Uint8Array, offset: number): void;
  /** truncate + chmod + chown + utimes: only the fields present apply. */
  touchSync(path: string, metadata: Partial<InodeLike>): void;
  /** Flush whatever is behind the store. A no-op for in-memory ones. */
  syncSync(): void;
}

export type Files = Record<string, string | Uint8Array>;

/**
 * The zero-dependency default store: JS objects, nothing persisted, state dies
 * with the run. Writes are copy-on-write against `files`, so a caller's
 * mounted buffer is never mutated.
 */
export function memoryFs(files?: Files): MemoryFs;

export class MemoryFs implements FileSystem {
  constructor(files?: Files);
  statSync(path: string): InodeLike;
  readdirSync(path: string): string[];
  createFileSync(path: string, options?: Partial<InodeLike>): InodeLike;
  mkdirSync(path: string, options?: Partial<InodeLike>): InodeLike;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  linkSync(target: string, link: string): void;
  readSync(path: string, buffer: Uint8Array, start: number, end: number): void;
  writeSync(path: string, buffer: Uint8Array, offset: number): void;
  touchSync(path: string, metadata: Partial<InodeLike>): void;
  syncSync(): void;
}

/** A store prepared by {@link persistentFs}: the same object, plus `flush()`. */
export type PersistentFileSystem<T> = T & {
  /**
   * Wait for every write so far to reach the backing store, and raise the
   * first that did not. The verb `syncSync()` would be if anything synchronous
   * could await OPFS.
   */
  flush(): Promise<void>;
};

export interface PersistentOptions {
  /** Called with each write-back failure, as it happens. */
  onError?(error: FsError | Error): void;
}

/**
 * Prepare a persistent store for a session: hydrate it, and give the writes
 * behind it somewhere to report a failure.
 *
 * An adapter, not a backend — `backing` is the embedder's, typically
 * `@zenfs/dom`'s `WebAccess` over an OPFS or user-granted directory handle.
 * Returns the same object so a second guest still sees the class it was handed.
 */
export function persistentFs<T extends FileSystem>(
  backing: T,
  options?: PersistentOptions,
): Promise<PersistentFileSystem<T>>;
