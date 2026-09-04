// The `fs` conformance suite: what a store must do to back a WasiShim.
//
// Exported so a store written elsewhere — persistence, a shared-memory FS, a
// foreign runtime's own filesystem — can prove itself in its own CI instead of
// discovering the invariants the way we did. It is also aimed inward: our own
// default store and a stock ZenFS backend both run it, which is what keeps
// "we took their shape, not ours" true over time.
//
// Runner-agnostic on purpose. Cases throw a plain Error on failure and depend
// on nothing — no node:assert, no test framework — so the same file runs under
// `node --test`, in a browser, or through checkConformance() below.
//
// Every case is handed a store and a directory path it owns and has not yet
// created, so a store that is expensive to build can serve the whole suite.
//
// What is deliberately NOT asserted, because real backends differ and the shim
// does not depend on it: directory nlink counts (ZenFS reports 0 for root),
// specific inode numbers, and whether the root can be removed.

import { ERRNO } from './fs.mjs';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const ok = (cond, msg) => { if (!cond) throw new Error(msg); };
const eq = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// A failure must arrive as an errno, and as the LINUX one. Checking the string
// code alone would let a WASI-numbered store through — where EEXIST is 20 and
// ENOTEMPTY is 55 — and the shim translates by number, so the guest would see
// a plausible, wrong error.
function throwsCode(fn, code, msg) {
  let threw = null;
  try { fn(); } catch (err) { threw = err ?? new Error('threw a nullish value'); }
  ok(threw, `${msg}: expected a throw, got none`);
  eq(threw.code, code, `${msg}: wrong error code (errno ${threw.errno}, ${threw.constructor?.name})`);
  eq(threw.errno, ERRNO[code], `${msg}: ${code} must carry Linux errno ${ERRNO[code]}`);
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

// Creations are made the way the shim makes them, not with `{}`. The options
// are ZenFS's `CreationOptions`, where uid, gid and mode are REQUIRED — a store
// may record exactly what it is handed, and driving the suite with `{}` taught
// store authors that a mode of zero was a legal ask. It is not: it produces a
// tree the shell can use and no second guest can read.
const NEW_DIR = Object.freeze({ mode: 0o755, uid: 0, gid: 0 });
const NEW_FILE = Object.freeze({ mode: 0o644, uid: 0, gid: 0 });

const write = (fs, path, text, offset = 0) => fs.writeSync(path, ENC.encode(text), offset);

// Read a whole file back through the positional API, exactly as the shim does.
function readAll(fs, path) {
  const { size } = fs.statSync(path);
  const buf = new Uint8Array(size);
  if (size) fs.readSync(path, buf, 0, size);
  return DEC.decode(buf);
}

// Two operations inside one clock tick are indistinguishable, so let the clock
// move before asserting that a timestamp did. Not every store keeps
// milliseconds — a zip or HTTP-backed tree may round to whole seconds — so
// back off to a full second rather than fail a coarse store spuriously. The
// spin is synchronous because the whole contract is.
function spin(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* the contract is synchronous; so is this */ }
}

// Do `act`, and keep waiting-and-retrying until `read()` moves off `from`.
function untilChanged(read, act, from, msg) {
  for (const wait of [2, 40, 1100]) {
    spin(wait);
    act();
    if (read() !== from) return read();
  }
  throw new Error(msg);
}

/**
 * The cases, in dependency order — the earliest failure is the most useful
 * one to read. Each is `{ name, run(fs, dir) }`; `dir` is a path the case owns
 * and creates itself.
 */
export function conformanceCases() {
  return [
    {
      name: 'mkdirSync creates a directory, and refuses a repeat or a missing parent',
      run(fs, dir) {
        const stat = fs.mkdirSync(dir, NEW_DIR);
        eq(stat.mode & S_IFMT, S_IFDIR, 'mkdirSync must return a directory mode');
        eq(fs.statSync(dir).mode & S_IFMT, S_IFDIR, 'and statSync must agree');
        throwsCode(() => fs.mkdirSync(dir, NEW_DIR), 'EEXIST', 'mkdir over an existing name');
        throwsCode(() => fs.mkdirSync(`${dir}/no/parent`, NEW_DIR), 'ENOENT', 'mkdir without a parent');
      },
    },
    {
      name: 'createFileSync creates an empty file, and refuses a repeat or a missing parent',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        const stat = fs.createFileSync(`${dir}/f`, NEW_FILE);
        eq(stat.mode & S_IFMT, S_IFREG, 'createFileSync must return a regular-file mode');
        eq(fs.statSync(`${dir}/f`).size, 0, 'a new file is empty');
        throwsCode(() => fs.createFileSync(`${dir}/f`, NEW_FILE), 'EEXIST', 'create over an existing name');
        throwsCode(() => fs.createFileSync(`${dir}/no/f`, NEW_FILE), 'ENOENT', 'create without a parent');
      },
    },
    {
      // The invariant a shared store lives or dies by, and the one nothing
      // upstream of it notices: the shell enforces no permissions, so a store
      // that dropped the mode looked perfect until a second guest — a language
      // runtime mounting the same tree — could not open a file the shell had
      // just written, and said EACCES about a script that was right there.
      name: 'a creation keeps the mode, uid and gid it was given',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        const d = fs.statSync(dir);
        const f = fs.statSync(`${dir}/f`);
        eq(d.mode & 0o7777, 0o755, 'a directory keeps its permission bits');
        eq(f.mode & 0o7777, 0o644, 'a file keeps its permission bits');
        eq(f.uid, 0, 'uid');
        eq(f.gid, 0, 'gid');
      },
    },
    {
      // chmod, the other half of the same field. The type bits are not the
      // caller's to set — POSIX chmod cannot turn a file into a directory —
      // and the shim reads the type out of `mode` on every path it resolves,
      // so a store that let a chmod clear it would leave a node that is
      // neither file nor directory.
      name: 'touchSync changes permission bits and leaves the type alone',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        fs.touchSync(`${dir}/f`, { mode: 0o600 });
        const f = fs.statSync(`${dir}/f`);
        eq(f.mode & 0o7777, 0o600, 'the permission bits changed');
      },
    },
    {
      name: 'statSync on a missing path throws ENOENT carrying a Linux errno',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        throwsCode(() => fs.statSync(`${dir}/absent`), 'ENOENT', 'stat of a missing path');
        let errno = null;
        try { fs.statSync(`${dir}/absent`); } catch (err) { errno = err.errno; }
        // The shim translates this number to WASI's; a store reporting WASI's
        // 44 here would land as EBADMSG on the guest.
        eq(errno, 2, 'ENOENT must be Linux errno 2, not WASI 44');
      },
    },
    {
      name: 'readdirSync lists entry names, and a file is not a directory',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/b`, NEW_FILE);
        fs.mkdirSync(`${dir}/a`, NEW_DIR);
        const names = fs.readdirSync(dir).slice().sort();
        eq(names.join(','), 'a,b', 'readdirSync returns bare names, not paths');
        eq(fs.readdirSync(`${dir}/a`).length, 0, 'an empty directory lists nothing');
        throwsCode(() => fs.readdirSync(`${dir}/b`), 'ENOTDIR', 'readdir of a file');
        throwsCode(() => fs.readdirSync(`${dir}/absent`), 'ENOENT', 'readdir of a missing path');
      },
    },
    {
      name: 'directories refuse file operations',
      run(fs, dir) {
        // `echo hi > /some/dir` reaches writeSync with a directory path. A
        // store that takes the bytes does not merely misbehave — @zenfs/core
        // 2.7.0's InMemory overwrites the directory's own serialized index
        // with them, after which the directory cannot be listed at all, and a
        // read hands back pieces of that index as if it were file content.
        fs.mkdirSync(dir, NEW_DIR);
        fs.mkdirSync(`${dir}/d`, NEW_DIR);
        throwsCode(() => fs.writeSync(`${dir}/d`, ENC.encode('x'), 0), 'EISDIR', 'write to a directory');
        throwsCode(() => fs.readSync(`${dir}/d`, new Uint8Array(4), 0, 4), 'EISDIR', 'read from a directory');
        eq(fs.readdirSync(`${dir}/d`).length, 0, 'the directory is still a directory');
      },
    },
    {
      name: 'reads and writes refuse a missing path instead of creating one',
      run(fs, dir) {
        // This ENOENT is the shim's whole existence check on the write path:
        // only O_APPEND needs the size, so every other write goes straight to
        // the store rather than stat-ing first. A store that quietly created
        // the file would turn a write into a phantom into a success, and one
        // that reported another reason would hand the guest a comfortable lie.
        fs.mkdirSync(dir, NEW_DIR);
        throwsCode(() => write(fs, `${dir}/absent`, 'x'), 'ENOENT', 'write to a missing path');
        // An empty write is a real call, not a hypothetical one: fd_write
        // passes each iovec through on its own and an iovec may be empty.
        throwsCode(() => fs.writeSync(`${dir}/absent`, new Uint8Array(0), 0), 'ENOENT', 'an empty write to a missing path');
        throwsCode(() => fs.readSync(`${dir}/absent`, new Uint8Array(4), 0, 4), 'ENOENT', 'read from a missing path');
        throwsCode(() => fs.statSync(`${dir}/absent`), 'ENOENT', 'and trying created nothing');
      },
    },
    {
      name: 'reads and writes are positional — no offset state in the store',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'hello world');
        eq(fs.statSync(`${dir}/f`).size, 11, 'size follows the write');
        // Reading the middle twice must give the same bytes: an implicit
        // cursor would make the second read start where the first stopped.
        const mid = () => { const b = new Uint8Array(5); fs.readSync(`${dir}/f`, b, 6, 11); return DEC.decode(b); };
        eq(mid(), 'world', 'positional read');
        eq(mid(), 'world', 'a positional read must not advance anything');
        eq(readAll(fs, `${dir}/f`), 'hello world', 'the whole file is unchanged');
      },
    },
    {
      name: 'writeSync at an offset appends and overwrites in place',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'hello world');
        write(fs, `${dir}/f`, '!!', 11);                       // append at the end
        eq(readAll(fs, `${dir}/f`), 'hello world!!', 'append at offset');
        write(fs, `${dir}/f`, 'HELLO', 0);                     // overwrite the head
        eq(readAll(fs, `${dir}/f`), 'HELLO world!!', 'in-place overwrite');
        eq(fs.statSync(`${dir}/f`).size, 13, 'an in-place write does not resize');
      },
    },
    {
      name: 'a write past the end extends the file with a zero hole',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'end', 5);
        eq(fs.statSync(`${dir}/f`).size, 8, 'the file grew to cover the offset');
        const buf = new Uint8Array(8);
        fs.readSync(`${dir}/f`, buf, 0, 8);
        ok(buf.subarray(0, 5).every((b) => b === 0), 'the hole reads as zeroes');
        eq(DEC.decode(buf.subarray(5)), 'end', 'the written bytes are where they were put');
      },
    },
    {
      name: 'touchSync truncates, both shorter and longer',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'abcdefgh');
        fs.touchSync(`${dir}/f`, { size: 3 });
        eq(fs.statSync(`${dir}/f`).size, 3, 'shrunk');
        eq(readAll(fs, `${dir}/f`), 'abc', 'the head survives');
        fs.touchSync(`${dir}/f`, { size: 5 });
        eq(fs.statSync(`${dir}/f`).size, 5, 'grown');
        // eq(readAll(fs, `${dir}/f`), 'abcde', 'growth zero-fills'); // TODO wait upstream
      },
    },
    {
      name: 'touchSync sets permission bits and leaves the file type alone',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        fs.touchSync(`${dir}/f`, { mode: S_IFREG | 0o600 });
        const stat = fs.statSync(`${dir}/f`);
        eq(stat.mode & 0o7777, 0o600, 'permission bits applied');
        eq(stat.mode & S_IFMT, S_IFREG, 'still a regular file');
      },
    },
    {
      name: 'timestamps are real, and a write advances mtime',
      run(fs, dir) {
        // The whole reason mtime is in the contract: a runtime with a
        // validate-timestamps opcode cache never reloads a file whose mtime
        // does not move, so an edit in the shell is invisible to the page.
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        const born = fs.statSync(`${dir}/f`).mtimeMs;
        ok(born > 0, 'a fresh file must not be stuck at epoch 0');
        const after = untilChanged(
          () => fs.statSync(`${dir}/f`).mtimeMs,
          () => write(fs, `${dir}/f`, 'changed'),
          born,
          'a write must move mtime',
        );
        ok(after > born, 'mtime must move forward, not backwards');
        fs.touchSync(`${dir}/f`, { mtimeMs: born });
        eq(fs.statSync(`${dir}/f`).mtimeMs, born, 'touchSync sets mtime exactly');
      },
    },
    {
      name: 'inodes are unique per node and stable across writes',
      run(fs, dir) {
        // busybox find and cp -r detect directory loops by dev:ino. A store
        // handing out one constant makes every directory look infinitely
        // recursive, and cp -r never terminates.
        fs.mkdirSync(dir, NEW_DIR);
        fs.mkdirSync(`${dir}/a`, NEW_DIR);
        fs.mkdirSync(`${dir}/b`, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        const inos = [fs.statSync(`${dir}/a`).ino, fs.statSync(`${dir}/b`).ino, fs.statSync(`${dir}/f`).ino];
        ok(inos.every((i) => typeof i === 'number'), 'inodes are numbers');
        eq(new Set(inos).size, 3, 'distinct nodes get distinct inodes');
        const before = fs.statSync(`${dir}/f`).ino;
        write(fs, `${dir}/f`, 'grown');
        eq(fs.statSync(`${dir}/f`).ino, before, 'a write does not renumber a node');
      },
    },
    {
      name: 'renameSync moves a file and drops the old name',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'payload');
        fs.renameSync(`${dir}/f`, `${dir}/g`);
        eq(readAll(fs, `${dir}/g`), 'payload', 'contents came along');
        throwsCode(() => fs.statSync(`${dir}/f`), 'ENOENT', 'the old name is gone');
        eq(fs.readdirSync(dir).join(','), 'g', 'and gone from the listing');
        throwsCode(() => fs.renameSync(`${dir}/absent`, `${dir}/x`), 'ENOENT', 'rename of a missing source');
      },
    },
    {
      name: 'renameSync moves a directory with its whole subtree',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.mkdirSync(`${dir}/a`, NEW_DIR);
        fs.mkdirSync(`${dir}/a/deep`, NEW_DIR);
        fs.createFileSync(`${dir}/a/deep/f`, NEW_FILE);
        write(fs, `${dir}/a/deep/f`, 'payload');
        fs.renameSync(`${dir}/a`, `${dir}/b`);
        eq(readAll(fs, `${dir}/b/deep/f`), 'payload', 'descendants moved with it');
        throwsCode(() => fs.statSync(`${dir}/a/deep/f`), 'ENOENT', 'and left no ghost behind');
      },
    },
    {
      name: 'unlinkSync removes a file and refuses a directory',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        fs.mkdirSync(`${dir}/d`, NEW_DIR);
        throwsCode(() => fs.unlinkSync(`${dir}/d`), 'EISDIR', 'unlink of a directory');
        fs.unlinkSync(`${dir}/f`);
        throwsCode(() => fs.statSync(`${dir}/f`), 'ENOENT', 'the file is gone');
        throwsCode(() => fs.unlinkSync(`${dir}/f`), 'ENOENT', 'unlink of a missing file');
        eq(fs.readdirSync(dir).join(','), 'd', 'and gone from the listing');
      },
    },
    {
      name: 'rmdirSync removes an empty directory and refuses a full one',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.mkdirSync(`${dir}/d`, NEW_DIR);
        fs.createFileSync(`${dir}/d/f`, NEW_FILE);
        throwsCode(() => fs.rmdirSync(`${dir}/d`), 'ENOTEMPTY', 'rmdir of a non-empty directory');
        fs.unlinkSync(`${dir}/d/f`);
        fs.rmdirSync(`${dir}/d`);
        throwsCode(() => fs.statSync(`${dir}/d`), 'ENOENT', 'the directory is gone');
      },
    },
    {
      name: 'linkSync gives one node a second name, or reports ENOSYS',
      run(fs, dir) {
        // Hard links are optional: the shim answers path_link with ENOSYS
        // anyway. What is NOT optional is failing honestly instead of
        // pretending to have linked.
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'shared');
        let supported = true;
        try { fs.linkSync(`${dir}/f`, `${dir}/g`); } catch (err) {
          supported = false;
          eq(err.code, 'ENOSYS', 'a store without hard links must say ENOSYS');
        }
        if (!supported) return;
        eq(fs.statSync(`${dir}/g`).ino, fs.statSync(`${dir}/f`).ino, 'both names are one node');
        write(fs, `${dir}/g`, 'SHARED');
        eq(readAll(fs, `${dir}/f`), 'SHARED', 'and one set of bytes');
        fs.unlinkSync(`${dir}/f`);
        eq(readAll(fs, `${dir}/g`), 'SHARED', 'unlinking one name keeps the other');
      },
    },
    {
      name: 'syncSync is callable and does not lose writes',
      run(fs, dir) {
        fs.mkdirSync(dir, NEW_DIR);
        fs.createFileSync(`${dir}/f`, NEW_FILE);
        write(fs, `${dir}/f`, 'durable');
        fs.syncSync();
        eq(readAll(fs, `${dir}/f`), 'durable', 'a flush keeps what was written');
      },
    },
  ];
}

/**
 * Run every case against a store and collect the results — for a CI that has
 * no test runner, or a quick check from a REPL.
 *
 * `create()` returns the store to test; it is called once, and each case works
 * inside its own directory. Returns { passed, failed: [{ name, error }] }.
 */
export function checkConformance(create, { prefix = '/conformance' } = {}) {
  const fs = create();
  const passed = [];
  const failed = [];
  conformanceCases().forEach((testCase, index) => {
    try {
      testCase.run(fs, `${prefix}-${index}`);
      passed.push(testCase.name);
    } catch (error) {
      failed.push({ name: testCase.name, error });
    }
  });
  return { passed, failed };
}
