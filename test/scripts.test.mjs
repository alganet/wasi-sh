// End-to-end script execution through run() against the shipped wasm.
// Cases ported from the POC's forkfree-poc/test-*.mjs, whose expectations
// lived in comments — here they are real assertions.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { compileWasm, runScript } from '../src/node.mjs';

let wasm;
before(async () => { wasm = await compileWasm(); });

// Run with the POC harness env (LC_ALL=C, PATH=/) for byte-identical behavior.
const sh = (script, opts = {}) => runScript(script, { wasm, env: { LC_ALL: 'C' }, ...opts });

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
