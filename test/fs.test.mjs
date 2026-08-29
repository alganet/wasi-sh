// memoryFs's own behaviour: seeding, copy-on-write and the invariants the
// shim leans on. The contract itself is pinned by the conformance suite —
// this file covers what is specific to the in-memory store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryFs, isDir, isFile, S_IFMT } from '../src/fs.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const readAll = (fs, path) => {
  const { size } = fs.statSync(path);
  const buf = new Uint8Array(size);
  fs.readSync(path, buf, 0, size);
  return dec.decode(buf);
};

test('seeds relative and unnormalized paths at normalized absolutes', () => {
  const fs = memoryFs({ 'rel.txt': 'r', '/a/./b/../c.txt': 'c' });
  assert.equal(readAll(fs, '/rel.txt'), 'r');
  assert.equal(readAll(fs, '/a/c.txt'), 'c', '. and .. collapse');
  assert.ok(isDir(fs.statSync('/a').mode), 'parent dirs are synthesized');
  assert.deepEqual(fs.readdirSync('/a'), ['c.txt']);
});

test('/ and /tmp exist in a store with no files', () => {
  const fs = memoryFs();
  assert.ok(isDir(fs.statSync('/').mode));
  assert.ok(isDir(fs.statSync('/tmp').mode));
  assert.deepEqual(fs.readdirSync('/'), ['tmp']);
});

test('copy-on-write: a seeded buffer is never mutated', () => {
  const mounted = enc.encode('pristine');
  const fs = memoryFs({ '/m.bin': mounted });
  fs.writeSync('/m.bin', enc.encode('scribble'), 0);
  assert.equal(dec.decode(mounted), 'pristine', 'caller buffer untouched');
  assert.equal(readAll(fs, '/m.bin'), 'scribble', 'the store sees the write');
});

test('copy-on-write also covers truncation through touchSync', () => {
  const mounted = enc.encode('pristine');
  const fs = memoryFs({ '/m.bin': mounted });
  fs.touchSync('/m.bin', { size: 4 });
  assert.equal(dec.decode(mounted), 'pristine');
  assert.equal(readAll(fs, '/m.bin'), 'pris');
});

test('two stores can share one seed map', () => {
  const files = { '/f.txt': enc.encode('seed') };
  const a = memoryFs(files);
  const b = memoryFs(files);
  a.writeSync('/f.txt', enc.encode('AAAA'), 0);
  assert.equal(readAll(b, '/f.txt'), 'seed', 'the second store is unaffected');
});

test('the type bits of a mode are not the caller`s to rewrite', () => {
  // The conformance suite pins that permission bits apply; this pins that a
  // caller cannot smuggle a new file TYPE in through the same field.
  const fs = memoryFs({ '/f.txt': 'x' });
  fs.touchSync('/f.txt', { mode: 0o40777 });
  const { mode } = fs.statSync('/f.txt');
  assert.ok(isFile(mode), 'still a regular file');
  assert.equal(mode & 0o7777, 0o777, 'permission bits did apply');
});

test('a rename into its own subtree is refused, and moves nothing', () => {
  const fs = memoryFs({ '/a/deep/f.txt': 'payload' });
  assert.throws(() => fs.renameSync('/a', '/a/deep/a'), { code: 'EINVAL' });
  assert.equal(readAll(fs, '/a/deep/f.txt'), 'payload', 'a refused rename moved nothing');
  fs.renameSync('/a', '/b');
  assert.deepEqual(fs.readdirSync('/').sort(), ['b', 'tmp']);
});

test('hard links are real, but never to a directory', () => {
  const fs = memoryFs({ '/f.txt': 'shared' });
  fs.linkSync('/f.txt', '/also.txt');
  assert.equal(fs.statSync('/f.txt').nlink, 2);
  fs.unlinkSync('/f.txt');
  assert.equal(fs.statSync('/also.txt').nlink, 1);
  assert.throws(() => fs.linkSync('/tmp', '/tmp2'), { code: 'EPERM' }, 'no directory links');
});

test('paths that name nothing, and the root, are refused', () => {
  const fs = memoryFs();
  assert.throws(() => fs.statSync(''), { code: 'ENOENT' }, 'an empty path is not the root');
  assert.throws(() => fs.rmdirSync('/'), { code: 'EBUSY' }, 'the root cannot be removed');
  assert.throws(() => fs.renameSync('/', '/elsewhere'), { code: 'EBUSY' });
});

test('a seed that collides with a directory is refused, not silently applied', () => {
  assert.throws(() => memoryFs({ '/f.txt': 'x', '/f.txt/under': 'y' }), { code: 'ENOTDIR' });
  assert.throws(() => memoryFs({ '/d/f.txt': 'x', '/d': 'y' }), { code: 'EISDIR' });
  assert.throws(() => memoryFs({ '/tmp': 'not a dir' }), { code: 'EISDIR' });
});

test('an ArrayBuffer seed is copy-on-write too', () => {
  const backing = enc.encode('pristine').buffer;
  const fs = memoryFs({ '/m.bin': backing });
  fs.writeSync('/m.bin', enc.encode('scribble'), 0);
  assert.equal(dec.decode(new Uint8Array(backing)), 'pristine');
  assert.equal(readAll(fs, '/m.bin'), 'scribble');
});

test('reads past EOF are short and zero the tail, never stale bytes', () => {
  // The shim clamps its read ranges to the file size, so this is belt and
  // braces: whatever the caller's buffer held must not surface as content.
  const fs = memoryFs({ '/f.txt': 'abc' });
  const buf = enc.encode('XXXXXXXX');
  fs.readSync('/f.txt', buf, 0, 8);
  assert.equal(dec.decode(buf.subarray(0, 3)), 'abc');
  assert.deepEqual([...buf.subarray(3)], [0, 0, 0, 0, 0]);
});

test('a directory nlink counts its subdirectories', () => {
  const fs = memoryFs();
  assert.equal(fs.statSync('/tmp').nlink, 2, 'an empty dir is 2');
  fs.mkdirSync('/tmp/a');
  fs.mkdirSync('/tmp/b');
  assert.equal(fs.statSync('/tmp').nlink, 4);
  fs.createFileSync('/tmp/f');
  assert.equal(fs.statSync('/tmp').nlink, 4, 'files do not count');
  fs.rmdirSync('/tmp/a');
  assert.equal(fs.statSync('/tmp').nlink, 3);
});

test('removing an entry moves the parent mtime', async () => {
  const fs = memoryFs({ '/d/f.txt': 'x', '/d/g.txt': 'y' });
  const before = fs.statSync('/d').mtimeMs;
  await new Promise((r) => setTimeout(r, 2));
  fs.unlinkSync('/d/f.txt');
  const afterUnlink = fs.statSync('/d').mtimeMs;
  assert.ok(afterUnlink > before, 'unlink is a directory modification');
  await new Promise((r) => setTimeout(r, 2));
  fs.renameSync('/d/g.txt', '/d/h.txt');
  assert.ok(fs.statSync('/d').mtimeMs > afterUnlink, 'so is a rename');
});

test('rename moves ctime, not mtime', async () => {
  const fs = memoryFs({ '/f.txt': 'x' });
  const { mtimeMs, ctimeMs } = fs.statSync('/f.txt');
  await new Promise((r) => setTimeout(r, 2));
  fs.renameSync('/f.txt', '/g.txt');
  const after = fs.statSync('/g.txt');
  assert.equal(after.mtimeMs, mtimeMs, 'mv must not look like an edit');
  assert.ok(after.ctimeMs > ctimeMs);
});

test('the mode of a seeded file is a plain 0644 regular file', () => {
  const fs = memoryFs({ '/f.txt': 'x' });
  assert.equal(fs.statSync('/f.txt').mode & S_IFMT, 0o100000);
  assert.equal(fs.statSync('/f.txt').mode & 0o7777, 0o644);
  assert.equal(fs.statSync('/tmp').mode & 0o7777, 0o755);
});
