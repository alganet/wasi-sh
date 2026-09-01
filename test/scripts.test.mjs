// End-to-end script execution through run() against the shipped wasm.
// Cases ported from the POC's forkfree-poc/test-*.mjs, whose expectations
// lived in comments — here they are real assertions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { compileWasm, runScript } from '../src/node.mjs';
import { WasiShim } from '../src/shim.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

// Run with the POC harness env (LC_ALL=C, PATH=/) for byte-identical behavior.
const sh = (script, opts = {}) => runScript(script, { wasm, env: { LC_ALL: 'C' }, ...opts });

// ─── the preopen fd ──────────────────────────────────────────────────────────
// fd 3 is not an ordinary fd here: wasi-libc scans the preopen table once at
// startup, finds '/' there, and from then on every absolute path in the program
// is addressed as a relative one through that number. A shell is entitled to
// redirect onto fd 3, and doing so must not take the root away from everything
// after it.

test('a redirection onto fd 3 does not take the filesystem root away', async () => {
  const r = await sh('exec 3< /data.txt\nread -r line <&3\necho "read=$line"\necho written > /tmp/a\ncat /tmp/a\n',
    { files: { '/data.txt': 'from fd 3\n' } });
  assert.equal(r.stdout, 'read=from fd 3\nwritten\n');
  assert.equal(r.stderr, '', 'the open used to fail with "nonexistent directory"');
});

test('and an absolute path opened while fd 3 is redirected still lands', async () => {
  const r = await sh('while read -r l <&3; do echo "$l" >> /tmp/log; done 3< /in.txt\ncat /tmp/log\n',
    { files: { '/in.txt': 'a\nb\n' } });
  assert.equal(r.stdout, 'a\nb\n');
});

// ─── basics ──────────────────────────────────────────────────────────────────

test('echo + quoting', async () => {
  const r = await sh('echo "hello world"');
  assert.equal(r.stdout, 'hello world\n');
  assert.equal(r.exitCode, 0);
});

test('variables and parameter expansion', async () => {
  const r = await sh('x=abc; echo "${x}def" "${#x}" "${x#a}"');
  assert.equal(r.stdout, 'abcdef 3 bc\n');
});

test('arithmetic including base-N (the MATH_BASE regression)', async () => {
  const r = await sh('echo $((6*7)) $((10#09)) $((0x1F)) $((2#101))');
  assert.equal(r.stdout, '42 9 31 5\n');
});

test('heredoc', async () => {
  const r = await sh('while read -r l; do echo "L:$l"; done <<EOF\none\ntwo\nEOF');
  assert.equal(r.stdout, 'L:one\nL:two\n');
});

test('read from stdin option', async () => {
  const r = await sh('read -r a; read -r b; echo "got $a then $b"', { stdin: 'first\nsecond\n' });
  assert.equal(r.stdout, 'got first then second\n');
});

test('stdin EOF terminates while read', async () => {
  const r = await sh('n=0; while read -r _; do n=$((n+1)); done; echo "lines=$n"', { stdin: 'a\nb\nc\n' });
  assert.equal(r.stdout, 'lines=3\n');
});

test('positional parameters via args', async () => {
  const r = await runScript('', {
    wasm,
    args: ['busybox', 'sh', '-c', 'echo "$1-$2"', 'sh', 'one', 'two'],
  });
  assert.equal(r.stdout, 'one-two\n');
});

test('command option (sh -c sugar)', async () => {
  const { run } = await import('../src/node.mjs');
  const r = await run({ wasm, command: 'echo via-command', inline: true });
  assert.equal(r.stdout, 'via-command\n');
});

test('exit code propagates', async () => {
  const r = await sh('exit 3');
  assert.equal(r.exitCode, 3);
});

test('stderr is captured separately', async () => {
  const r = await sh('echo out; echo err 1>&2');
  assert.equal(r.stdout, 'out\n');
  assert.equal(r.stderr, 'err\n');
});

test('onOutput streams bytes with channel', async () => {
  const seen = [];
  await sh('echo a; echo b 1>&2', {
    onOutput: (bytes, channel) => seen.push([channel, new TextDecoder().decode(bytes)]),
  });
  assert.deepEqual(seen, [['stdout', 'a\n'], ['stderr', 'b\n']]);
});

test('mounted files are readable', async () => {
  const r = await sh('read -r l < /data/greeting.txt; echo "file says: $l"', {
    files: { '/data/greeting.txt': 'hi from the fs\n' },
  });
  assert.equal(r.stdout, 'file says: hi from the fs\n');
});

// ─── writable in-memory FS ────────────────────────────────────────────────────

test('redirect to /tmp: written then read back', async () => {
  const r = await sh('echo hello > /tmp/f; read x < /tmp/f; echo "x=[$x]"');
  assert.equal(r.stdout, 'x=[hello]\n');
});

test('>> appends across redirects', async () => {
  const r = await sh('echo a > /tmp/log; echo b >> /tmp/log; while read -r l; do echo "L:$l"; done < /tmp/log');
  assert.equal(r.stdout, 'L:a\nL:b\n');
});

test('overwriting a mounted file works in-sandbox, caller buffer untouched', async () => {
  const mounted = new TextEncoder().encode('original\n');
  const r = await sh('echo clobber > /data/in.txt; read x < /data/in.txt; echo "x=[$x]"', {
    files: { '/data/in.txt': mounted },
  });
  assert.equal(r.stdout, 'x=[clobber]\n');
  assert.equal(new TextDecoder().decode(mounted), 'original\n', 'CoW protects the caller');
});

test('redirect into a missing directory still fails loudly', async () => {
  const r = await sh('echo x > /nope/f.txt; echo "rc=$?"');
  assert.equal(r.stdout, 'rc=1\n');
  assert.match(r.stderr, /can't create/);
});

test('reading a missing /tmp path is an error, not silent EOF', async () => {
  const r = await sh('read x < /tmp/missing; echo "rc=$?"');
  assert.match(r.stderr + r.stdout, /can't open|rc=[1-9]/);
});

// Regression: dup'd fds MUST share one seek offset (POSIX: one offset per open
// file description). __host_dup/__host_dup2 copy the descriptor with {...src},
// so a plain `off` number gave each dup a private offset — fd 1 and fd 2 both
// started at 0 under `> f 2>&1` and wrote over each other's bytes.
test("`> f 2>&1`: stdout and stderr share one offset, no overwrite", async () => {
  const r = await sh('{ echo OUTOUTOUT; ls /nope; echo TAIL; } > /tmp/f 2>&1; cat /tmp/f');
  assert.equal(r.stdout, 'OUTOUTOUT\nls: /nope: No such file or directory\nTAIL\n');
});

// Same root cause, other direction: the fork-free evalpipe saves fd 0 with
// fcntl(F_DUPFD,10) and restores it with dup2 around every stage. With private
// offsets the restore REWOUND a file-backed stdin, so bytes a pipeline stage
// had already consumed were served again to the next reader.
test('a pipeline stage does not rewind a file-backed stdin', async () => {
  const r = await sh('printf "L1\\nL2\\nL3\\n" > /in.txt; { read a; echo "a=$a"; cat | cat; read b; echo "b=[$b]"; } < /in.txt');
  assert.equal(r.stdout, 'a=L1\nL2\nL3\nb=[]\n', 'cat consumed L2/L3; the restore must not rewind');
});

// ─── in-process applets (busybox tools as builtins) ──────────────────────────

test('applets resolve before PATH; unknown commands still fail', async () => {
  // command -v / type know the applet table (busybox `which` does not — it
  // only scans PATH for real files, so it is deliberately not shipped).
  const r = await sh('command -v cat && type grep >/dev/null && echo have-tools; nosuchtool 2>/dev/null || echo absent; ln -s a b 2>/dev/null || echo no-ln');
  assert.equal(r.stdout, 'cat\nhave-tools\nabsent\nno-ln\n');
});

test('file tools: cat, wc, tail -n (fd_tell elimination path)', async () => {
  const r = await sh('seq 5 > /tmp/n; cat /tmp/n | wc -l; tail -n 2 /tmp/n | head -n 1');
  assert.equal(r.stdout, '5\n4\n');
});

test('mixed applet pipeline with command substitution', async () => {
  const r = await sh('x=$(seq 20 | awk "\\$1%3==0" | sort -rn | head -n 2 | tr "\\n" ","); echo "x=[$x]"');
  assert.equal(r.stdout, 'x=[18,15,]\n');
});

test('grep isolation: 30x alternating match/no-match in one session', async () => {
  const r = await sh(
    'i=0; ok=1; while [ $i -lt 30 ]; do echo needle | grep -q needle || ok=0; ' +
    'echo x | grep -q nomatch && ok=0; i=$((i+1)); done; echo "ok=$ok"'
  );
  assert.equal(r.stdout, 'ok=1\n', 'scratch-buffer + stdio-flag isolation held');
});

test('sed -i edits in place (mkstemp + rename + unlink chain)', async () => {
  const r = await sh('printf "aaa\\n" > /tmp/f; sed -i "s/a/b/g" /tmp/f; cat /tmp/f');
  assert.equal(r.stdout, 'bbb\n');
});

test("applet exit() is contained: awk exit sets $?, shell survives", async () => {
  const r = await sh('x=$(awk "BEGIN{print 42; exit 3}"); echo "x=$x rc=$?"; echo alive');
  assert.equal(r.stdout, 'x=42 rc=3\nalive\n');
});

test("shell's own exit still exits", async () => {
  const r = await sh('echo before; exit 7; echo never');
  assert.equal(r.stdout, 'before\n');
  assert.equal(r.exitCode, 7);
});

test('mv and cp -r across directories (rename + unique-inode paths)', async () => {
  const r = await sh(
    'mkdir -p /tmp/src/sub; echo deep > /tmp/src/sub/f; ' +
    'cp -r /tmp/src /tmp/copy 2>/dev/null; mv /tmp/src /tmp/moved; ' +
    'cat /tmp/copy/sub/f /tmp/moved/sub/f; test ! -e /tmp/src && echo gone'
  );
  assert.equal(r.stdout, 'deep\ndeep\ngone\n');
});

test('find descends, filters, and -execs in-process', async () => {
  const r = await sh(
    'mkdir /tmp/d; touch /tmp/d/a.sh /tmp/d/b.txt; ' +
    'find /tmp/d -name "*.sh" -exec echo hit {} \\; ; find /tmp/d -type f | wc -l'
  );
  assert.equal(r.stdout, 'hit /tmp/d/a.sh\n2\n');
});

test('awk over multiple file arguments (freopen / fd_renumber elimination)', async () => {
  const r = await sh('seq 2 > /tmp/a; seq 3 > /tmp/b; awk "FNR==1{print FILENAME}" /tmp/a /tmp/b; awk "{s+=\\$1} END{print s}" /tmp/a /tmp/b');
  assert.equal(r.stdout, '/tmp/a\n/tmp/b\n9\n');
});

test('touch creates and updates; mktemp allocates unique names', async () => {
  const r = await sh(
    'touch /tmp/t && test -f /tmp/t && echo created; touch /tmp/t && echo updated; ' +
    'a=$(mktemp); b=$(mktemp); test "$a" != "$b" && echo distinct'
  );
  assert.equal(r.stdout, 'created\nupdated\ndistinct\n');
});

test('stat -c and SUSv2 head -N forms work (config sub-features)', async () => {
  const r = await sh('printf 12345 > /tmp/s; stat -c "%s" /tmp/s; seq 5 | head -2 | tail -1');
  assert.equal(r.stdout, '5\n2\n');
});

test('hashes are stable', async () => {
  const r = await sh('printf abc | md5sum | cut -d" " -f1; printf abc | sha256sum | cut -c1-12');
  assert.equal(r.stdout, '900150983cd24fb0d6963f7d28e17f72\nba7816bf8f01\n');
});

// ─── fork-free command substitution (from test-cmdsubst.mjs) ─────────────────

test('cmdsubst: printf and echo', async () => {
  const r = await sh('x=$(printf "hello"); echo "got=[$x]"; echo "[$(echo world)]"');
  assert.equal(r.stdout, 'got=[hello]\n[world]\n');
});

test('cmdsubst: nested', async () => {
  const r = await sh('echo "[$(echo a$(echo B)c)]"');
  assert.equal(r.stdout, '[aBc]\n');
});

test('cmdsubst: multiline capture from a for loop', async () => {
  const r = await sh('out=$(for i in 1 2 3; do echo "line$i"; done); echo "$out"');
  assert.equal(r.stdout, 'line1\nline2\nline3\n');
});

test('cmdsubst: backticks', async () => {
  const r = await sh('echo "[`printf ABC`]"');
  assert.equal(r.stdout, '[ABC]\n');
});

test('cmdsubst: exit status in $?', async () => {
  const r = await sh('v=$(false); echo "rc=$?"; w=$(true); echo "rc2=$?"');
  assert.equal(r.stdout, 'rc=1\nrc2=0\n');
});

test('cmdsubst: octal printf table entry (ord.sh pattern)', async () => {
  // Shell must see printf "\\101" so printf receives \101 → 'A'.
  const r = await sh('_i=65;_d1=$((_i/64));_d2=$(((_i/8)%8));_d3=$((_i%8)); c=$(printf "\\\\${_d1}${_d2}${_d3}"); echo "c=[$c]"');
  assert.equal(r.stdout, 'c=[A]\n');
});

test('cmdsubst: exit N inside $() propagates to $?, shell lives on', async () => {
  const r = await sh('x=$(echo pre; exit 7; echo post); echo "x=[$x] rc=$?"; echo alive');
  assert.equal(r.stdout, 'x=[pre] rc=7\nalive\n');
});

// ─── fork-free builtin pipes (from test-pipes.mjs) ───────────────────────────

test('pipe: printf | while read', async () => {
  const r = await sh('printf "a\\nb\\nc\\n" | while read line; do echo "L:$line"; done');
  assert.equal(r.stdout, 'L:a\nL:b\nL:c\n');
});

test('pipe: three stages', async () => {
  const r = await sh('printf "1\\n2\\n3\\n4\\n" | while read n; do echo $((n*n)); done | while read sq; do echo "sq=$sq"; done');
  assert.equal(r.stdout, 'sq=1\nsq=4\nsq=9\nsq=16\n');
});

test('pipe: exit status is the last stage', async () => {
  const r = await sh('true | false; echo "rc=$?"; false | true; echo "rc2=$?"');
  assert.equal(r.stdout, 'rc=1\nrc2=0\n');
});

test('pipe inside cmdsubst', async () => {
  const r = await sh('r=$(printf "a\\nb\\nc\\n" | while read x; do printf "%s-" "$x"; done); echo "r=[$r]"');
  assert.equal(r.stdout, 'r=[a-b-c-]\n');
});

// ─── a short reader keeps nothing for the next applet ────────────────────────
// Fork-free, an applet's stdio buffer is the SHELL's. A short-reading applet
// (`head -1`, `sed q`, `grep -m1`) pulls a whole block, prints part of it and
// returns — and the remainder a forked child would have taken to the grave was
// still sitting in stdin when the next applet read. That corrupts data rather
// than merely surprising: the second reader got the first one's leftovers.
// Every case below printed something else entirely before the drain landed.
// A stale dist/busybox.wasm fails these; `npm run build:wasm` is the fix.

test('the same pipeline twice gives the same answer', async () => {
  const r = await sh('printf "l1\\nl2\\nl3\\n" | head -1\nprintf "l1\\nl2\\nl3\\n" | head -1\n');
  assert.equal(r.stdout, 'l1\nl1\n', 'the second head used to print l2');
});

test('and a wider read after a narrow one is all fresh', async () => {
  const r = await sh('printf "l1\\nl2\\nl3\\n" | head -1\nprintf "l1\\nl2\\nl3\\n" | head -2\n');
  assert.equal(r.stdout, 'l1\nl1\nl2\n', 'head -2 used to serve l2 and l3 out of the first head\'s buffer');
});

test('a loop body reading a pipe repeats itself exactly', async () => {
  const r = await sh('for i in 1 2 3; do seq 10 | head -2 | tr "\\n" " "; echo; done');
  assert.equal(r.stdout, '1 2 \n1 2 \n1 2 \n');
});

test('every short-reading applet, not just head', async () => {
  const r = await sh('printf "a\\nb\\nc\\n" | sed q\nprintf "a\\nb\\nc\\n" | grep -m1 .\n'
    + 'printf "a\\nb\\nc\\n" | awk "NR==1{print;exit}"\nprintf "p\\nq\\n" | head -1\n');
  assert.equal(r.stdout, 'a\na\na\np\n');
});

test('a heredoc does not leak into the next command', async () => {
  const r = await sh('head -1 <<EOT\nh1\nh2\nEOT\nprintf "p\\nq\\n" | head -1\n');
  assert.equal(r.stdout, 'h1\np\n', 'the pipeline used to print the heredoc\'s h2');
});

test('an applet that dies leaves nothing behind either', async () => {
  const r = await sh('printf "a\\nb\\nc\\n" | head -1\nhead -1 /nope 2>/dev/null\nprintf "p\\nq\\n" | head -1\n');
  assert.equal(r.stdout, 'a\np\n');
});

// On a SEEKABLE stdin the drain does better than dropping the bytes: fflush()
// puts the file offset back to where the reader actually stopped, so nothing
// is lost. Two separate redirections of one file each start at the top, and a
// `read` after an applet continues from the line the applet printed.

test('two redirections of one file each start at the top', async () => {
  const r = await sh('head -1 < /f\nhead -1 < /f\n', { files: { '/f': 'f1\nf2\nf3\n' } });
  assert.equal(r.stdout, 'f1\nf1\n', 'the second used to resume at f2');
});

test('and the offset is put back where the applet stopped, not where it read to', async () => {
  const r = await sh('{ head -1; read x; echo "read=$x"; } < /f\n', { files: { '/f': 'r1\nr2\nr3\n' } });
  assert.equal(r.stdout, 'r1\nread=r2\n', 'read used to see EOF: head had swallowed the file');
});

// The drain is outermost-only. xargs and find -exec run their children through
// the same run_nofork_applet(), and the stdin the OUTER applet has buffered is
// still its own to read.
test('an applet nested inside another does not drain its parent', async () => {
  const r = await sh('printf "a\\nb\\nc\\n" | xargs echo');
  assert.equal(r.stdout, 'a b c\n');
});

// ─── subshell isolation (from test-isolation.mjs) ────────────────────────────

test('isolation: vars set inside $() do not leak', async () => {
  const r = await sh('x=$(y=5; echo hi); echo "x=[$x] y=[$y]"');
  assert.equal(r.stdout, 'x=[hi] y=[]\n');
});

test('isolation: modified vars revert', async () => {
  const r = await sh('a=1; b=$(a=2; echo "$a"); echo "b=[$b] a=[$a]"');
  assert.equal(r.stdout, 'b=[2] a=[1]\n');
});

test('isolation: parent vars are readable inside', async () => {
  const r = await sh('v=42; r=$(echo "v is $v"); echo "$r"');
  assert.equal(r.stdout, 'v is 42\n');
});

test('isolation: nesting levels each revert', async () => {
  // $() preserves interior newlines (only trailing ones strip), so the
  // captured value is "3\n2" and each nesting level's p reverts.
  const r = await sh('p=1; echo "$(p=2; echo $(p=3; echo $p);echo $p)"; echo "p=$p"');
  assert.equal(r.stdout, '3\n2\np=1\n');
});

test('isolation: set -e inside $() does not escape', async () => {
  const r = await sh('set +e; z=$(set -e; false; echo after); echo "z=[$z]"; false; echo "still=$?"');
  assert.equal(r.stdout, 'z=[]\nstill=1\n');
});

test('isolation: pipe stages are subshells (POSIX ash)', async () => {
  const r = await sh('echo hi | read foo; echo "foo=[$foo]"');
  assert.equal(r.stdout, 'foo=[]\n');
});

// ─── host builtins (JS-backed command names) ─────────────────────────────────

// Only meaningful on a binary built with the host-builtin C support (compiled
// at `npm run build:wasm`); probe the module's imports so these stay green on
// an older dist/busybox.wasm instead of failing. The JS side is pinned
// unconditionally in test/builtins.test.mjs.
const HOSTB_READY = () => WebAssembly.Module.imports(wasm)
  .some((i) => i.module === 'env' && i.name === '__host_builtin_run');
const skipUnlessHostBuiltins = (t) => {
  if (HOSTB_READY()) return false;
  t.skip('dist/busybox.wasm predates host builtins — run npm run build:wasm');
  return true;
};

// `up` uppercases its args, or stdin when it has none. Deliberately not
// PHP-shaped: a host builtin is just a function.
const upper = {
  up: (ctx) => {
    const rest = ctx.argv.slice(1);
    const text = rest.length ? rest.join(' ') : new TextDecoder().decode(ctx.stdin());
    ctx.stdout(text.toUpperCase());
    return 0;
  },
};
const shb = (script, builtins = upper, opts = {}) => sh(script, { builtins, ...opts });

test('a host builtin runs, with argv', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('up hello world');
  assert.equal(r.stdout, 'HELLO WORLD');
  assert.equal(r.exitCode, 0);
});

// The whole point of routing through the fd table rather than the stdout
// callback: whatever the shell last dup2'd onto fd 1 is where the bytes go.
test('a host builtin composes in a pipeline', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('up abc def | tr " " "-"');
  assert.equal(r.stdout, 'ABC-DEF', 'fd 1 was the pipe, not the terminal');
});

// A write that a DEVICE refused used to come back as success, so a builtin
// replying through /dev/host on a session whose verb failed reported a reply it
// had not sent. `cmd > /dev/host || fallback` is how a server loop says "answer
// anyway", and it needs $? to be true.
test('a host builtin learns that its write failed', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb(
    'reply > /dev/host; echo "status=$?"',
    { reply: (ctx) => { ctx.stdout('answer\n'); return 0; } },
    { host: { answer: () => { throw new Error('nowhere to put it'); } } },
  );

  assert.match(r.stdout, /^status=[1-9]/, 'a refused write is not a delivered one');
  assert.match(r.stderr, /write to stdout failed: IO/);
});

test('a host builtin reads a pipe on stdin', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('printf "quiet\\n" | up');
  assert.equal(r.stdout, 'QUIET\n');
});

test('a host builtin honours a redirect', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('up to a file > /o.txt; cat /o.txt');
  assert.equal(r.stdout, 'TO A FILE');
});

test('a host builtin is captured by $(...)', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('x=$(up sub); echo "[$x]"');
  assert.equal(r.stdout, '[SUB]\n');
});

test('the return value becomes $?, truncated to 8 bits', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const rc = { rc: (ctx) => Number(ctx.argv[1]) };
  assert.equal((await shb('rc 0; echo "s=$?"', rc)).stdout, 's=0\n');
  assert.equal((await shb('rc 42; echo "s=$?"', rc)).stdout, 's=42\n');
  assert.equal((await shb('rc 255; echo "s=$?"', rc)).stdout, 's=255\n');
  assert.equal((await shb('rc 300; echo "s=$?"', rc)).stdout, 's=44\n', 'wait(2) truncation');
});

test('a host builtin sees exports and VAR=x prefixes, and the live cwd', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const probe = { probe: (ctx) => { ctx.stdout(`${ctx.cwd} ${ctx.env.FOO} ${ctx.env.BAR}\n`); return 0; } };
  const r = await shb('mkdir -p /w; cd /w; export BAR=exported; FOO=prefix probe', probe);
  assert.equal(r.stdout, '/w prefix exported\n', 'envp comes from listvars, cwd from getcwd');
});

test('`type` and `command -v` tell the truth about a host builtin', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  assert.equal((await shb('type up')).stdout, 'up is a host builtin\n');
  assert.equal((await shb('command -v up')).stdout, 'up\n', 'bare name, so "$(command -v up)" re-dispatches');
});

// Precedence: functions, shell builtins and busybox applets all win, so the
// shipped toolbox cannot be changed out from under a script.
test('an applet of the same name still wins', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('echo real', { echo: (ctx) => { ctx.stdout('HIJACKED'); return 0; } });
  assert.equal(r.stdout, 'real\n', 'registering `echo` must not change what echo means');
});

test('a throwing handler costs one command, not the shell', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await shb('boom; echo "after=$?"', { boom: () => { throw new Error('kaboom'); } });
  assert.equal(r.stdout, 'after=1\n', 'the shell survived and kept running');
  assert.match(r.stderr, /boom: kaboom/);
});

test('with nothing registered the shell is unchanged: 127 and "not found"', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  const r = await sh('up hi; echo "s=$?"');
  assert.equal(r.stdout, 's=127\n');
  assert.match(r.stderr, /up: not found/);
});

// Independent of host builtins, and fixed by the same patch: a slashed name
// took find_command's slash short circuit into vforkexec(), where vfork() is
// ENOSYS — ash raised "can't fork" with status 2 and ABORTED the script, so the
// echo never ran.
test('a slashed unknown name is 127, not a dead shell', async (t) => {
  if (skipUnlessHostBuiltins(t)) return;
  for (const name of ['/bin/nope', './nope.sh', 'foo/bar']) {
    const r = await sh(`${name}; echo "after=$?"`);
    assert.equal(r.stdout, 'after=127\n', `${name} must not abort the script`);
    assert.equal(r.exitCode, 0);
  }
});

// ─── shebangs, and the `env` that makes them useful ──────────────────────────
// On Linux the "#!" line is resolved inside execve(), in the kernel. There is
// no kernel here, so ash reads it itself (build/ash-shebang.patch) and splices
// the interpreter — by basename — in front of the command. `env` is a shell
// builtin for the same reason: the applet ends in execve(), which is ENOSYS.
//
// Probed at runtime rather than through the import table: this patch adds no
// wasm import, so an older dist/busybox.wasm is only visible in behaviour.
let shebangReady;
before(async () => {
  shebangReady = (await sh('type env')).stdout.includes('shell builtin');
});
const skipUnlessShebang = (t) => {
  if (shebangReady) return false;
  t.skip('dist/busybox.wasm predates shebang dispatch — run npm run build:wasm');
  return true;
};
// `greet` echoes the argv it was handed, so each test can see exactly what the
// interpreter received — the script path and its arguments, in that order.
const greeter = {
  greet: (ctx) => { ctx.stdout(`greet[${ctx.argv.slice(1).join('|')}]`); return 0; },
};

test('a #! file resolves through env to a host builtin, with the script path first', async (t) => {
  if (skipUnlessShebang(t) || skipUnlessHostBuiltins(t)) return;
  const r = await sh('./tool a b', { builtins: greeter, files: { '/tool': '#!/usr/bin/env greet\nignored\n' } });
  assert.equal(r.stdout, 'greet[./tool|a|b]');
  assert.equal(r.exitCode, 0);
});

test('the interpreter is taken by basename, so a bare #!/path/to/x works too', async (t) => {
  if (skipUnlessShebang(t) || skipUnlessHostBuiltins(t)) return;
  const r = await sh('./tool a', { builtins: greeter, files: { '/tool': '#!/opt/nowhere/greet\n' } });
  assert.equal(r.stdout, 'greet[./tool|a]');
});

test('a #! line carries at most one interpreter argument, Linux-style', async (t) => {
  if (skipUnlessShebang(t) || skipUnlessHostBuiltins(t)) return;
  const one = await sh('./tool z', { builtins: greeter, files: { '/tool': '#!/usr/bin/greet -x\n' } });
  assert.equal(one.stdout, 'greet[-x|./tool|z]');
  // Two words after the interpreter are ONE argument, not two — which is why
  // `#!/usr/bin/env -S` exists on Linux. Here that lands on a name with a space.
  const two = await sh('./tool z', { builtins: greeter, files: { '/tool': '#!/usr/bin/env greet -a -b\n' } });
  assert.equal(two.exitCode, 127);
  assert.match(two.stderr, /greet -a -b: not found/);
});

test('a #! file resolves to an applet as readily as to a host builtin', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./tool', { files: { '/tool': '#!/bin/cat\npayload\n' } });
  assert.equal(r.stdout, '#!/bin/cat\npayload\n', 'cat was handed the script path');
});

test('a #! file resolves to a shell function, which shadows everything else', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('greet() { echo "fn $*"; }\n./tool a\n', { files: { '/tool': '#!/usr/bin/greet\n' } });
  assert.equal(r.stdout, 'fn ./tool a\n');
});

test('a #! naming an interpreter that does not exist is 127 naming the interpreter', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./tool; echo "after=$?"', { files: { '/tool': '#!/usr/bin/nosuchthing\n' } });
  assert.equal(r.stdout, 'after=127\n');
  assert.match(r.stderr, /nosuchthing: not found/, 'the script path is the least useful thing to name here');
});

// Nothing but `env` can lead back into the shebang reader — every other
// interpreter is re-dispatched as a bare name and so can never take
// find_command's slash short circuit again. This is the one file that can:
// one called `env` whose own #! line names env.
test('a self-referential shebang is refused, not recursed, and names the file', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./env; echo "after=$?"', { files: { '/env': '#!/usr/bin/env\n' } });
  assert.equal(r.stdout, 'after=126\n');
  assert.match(r.stderr, /\.\/env: bad interpreter: #! loop/);
});

test('a #! line longer than the cap is refused rather than truncated', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./tool; echo "after=$?"', { files: { '/tool': `#!/usr/bin/${'x'.repeat(200)}\n` } });
  assert.equal(r.stdout, 'after=126\n');
  assert.match(r.stderr, /#! line too long/);
});

test('a #! with no interpreter after it is refused', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./tool; echo "after=$?"', { files: { '/tool': '#!\nx\n' } });
  assert.equal(r.stdout, 'after=126\n');
  assert.match(r.stderr, /no interpreter after #!/);
});

// busybox ash is not reentrant — ash_main() re-initialises all three globals
// structs and never restores them, so a nested shell takes the outer one's
// variables and script position with it (true of `sh script.sh` typed by hand
// too). Refuse loudly rather than make `./deploy.sh` the common way to hit it.
test('a #! naming the shell itself is refused, and the caller survives', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('./deploy.sh; echo "after=$?"\necho still-here\n',
    { files: { '/deploy.sh': '#!/bin/sh\necho hi\n' } });
  assert.equal(r.stdout, 'after=126\nstill-here\n');
  assert.match(r.stderr, /sh cannot run inside this shell/);
});

// The guard above this section says a slashed unknown name is 127. These say
// the shebang reader did not swallow that: a file with no "#!" is not a
// command, however readable it is.
test('a file with no #! is still 127, and still does not abort the script', async (t) => {
  if (skipUnlessShebang(t)) return;
  for (const body of ['plain text\n', '', '#', '#!']) {
    const r = await sh('./tool; echo "after=$?"', { files: { '/tool': body } });
    const expected = body === '#!' ? 'after=126\n' : 'after=127\n';
    assert.equal(r.stdout, expected, `body ${JSON.stringify(body)}`);
    assert.equal(r.exitCode, 0);
  }
});

test('env sets a variable for one command only', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('FOO=outer\nexport FOO\nenv FOO=inner printenv FOO\nprintenv FOO\n');
  assert.equal(r.stdout, 'inner\nouter\n');
});

test('bare env still prints the environment', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('export ZZ=1\nenv | grep "^ZZ="\n');
  assert.equal(r.stdout, 'ZZ=1\n');
});

test('env -i empties the environment, and -u drops one name', async (t) => {
  if (skipUnlessShebang(t)) return;
  const cleared = await sh('export ZZ=1\nenv -i printenv | wc -l\nprintenv ZZ\n');
  assert.equal(cleared.stdout, '0\n1\n', '-i is scoped to the one command');
  const kept = await sh('env -i FOO=kept printenv\n');
  assert.equal(kept.stdout, 'FOO=kept\n', '-i comes first, so a later assignment survives it');
  for (const spelling of ['-u ZZ', '-uZZ']) {
    const r = await sh(`export ZZ=1\nenv ${spelling} printenv | grep -c "^ZZ="\nprintenv ZZ\n`);
    assert.equal(r.stdout, '0\n1\n', `${spelling} drops it for the command and puts it back after`);
  }
});

test('env stops at the command word: what follows is argv, not an assignment', async (t) => {
  if (skipUnlessShebang(t) || skipUnlessHostBuiltins(t)) return;
  const r = await sh('env greet FOO=1', { builtins: greeter });
  assert.equal(r.stdout, 'greet[FOO=1]');
});

test('a shell function named env shadows the builtin', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('env() { echo "mine $*"; }\nenv FOO=1 true\n');
  assert.equal(r.stdout, 'mine FOO=1 true\n');
});

test('type and command -v tell the truth about env', async (t) => {
  if (skipUnlessShebang(t)) return;
  const r = await sh('type env\ncommand -v env\n');
  assert.equal(r.stdout, 'env is a shell builtin\nenv\n');
});

// Drift guard. --import-undefined means any unresolved __host_* symbol silently
// becomes a wasm import, so a typo or a new hook links cleanly and only fails at
// instantiate ("function import requires a callable") — in production, for every
// run. Pin the whole surface here instead: whatever the binary asks for, the
// shim must supply.
test('the shim supplies every env import the binary declares', () => {
  const shim = new WasiShim({});
  const supplied = shim.imports().env;
  const declared = WebAssembly.Module.imports(wasm)
    .filter((i) => i.module === 'env')
    .map((i) => i.name);
  const missing = declared.filter((n) => typeof supplied[n] !== 'function');
  assert.deepEqual(missing, [], `dist/busybox.wasm imports env.${missing.join('/')} but src/shim.mjs does not provide it`);
  assert.ok(declared.every((n) => n.startsWith('__host_')), `unexpected env import: ${declared.join(' ')}`);
});
