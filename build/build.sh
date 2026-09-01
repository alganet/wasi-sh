#!/bin/sh
# Build dist/busybox.wasm from source: busybox ash as a PLAIN wasm32-wasi
# module with the fork-free command-substitution/pipe patch.
#
#   build/build.sh [--plain] [--toolchain zig|ziglang|wasi-sdk] [--keep]
#
#   --plain      skip ash-forkfree.patch only (fork stays ENOSYS and every $( )
#                fails; you almost never want this)
#   --toolchain  zig      = a `zig` binary on PATH        (verified recipe)
#                ziglang  = `python3 -m ziglang` (pip install ziglang)
#                wasi-sdk = $WASI_SDK_PATH/bin/clang      (documented variant;
#                           same flags, simpler link — see notes below)
#   --keep       keep build/work/ around for inspection
#   --debug      keep DWARF in the output (see the strip note at the link)
#
# Everything is pinned and self-contained: the busybox tarball is fetched and
# SHA-256-verified, sources are patched from a pristine extract, and the
# result must pass a smoke test before it replaces dist/busybox.wasm.
#
# Toolchain notes (from the original port):
# - ash needs setjmp/longjmp; wasi-libc lowers them onto wasm
#   exception-handling: -mexception-handling -mllvm -wasm-enable-sjlj,
#   plus -mllvm -wasm-use-legacy-eh=false for the STANDARD EH encoding
#   (V8/wasmtime accept it; zig's clang defaults to the legacy one).
# - busybox kbuild folds each dir with `ld -r`; that maps onto
#   `wasm-ld --relocatable` (the zld wrapper).
# - The final link is done BY HAND with raw wasm-ld:
#     --import-undefined  leaves the env.__host_* hooks as wasm imports
#                         (implemented by the JS shim): the fd/winsize hooks
#                         plus __host_builtin_lookup/__host_builtin_run;
#     --wrap fcntl        routes ash's fcntl() through wasistubs.c's
#                         __wrap_fcntl so F_DUPFD reaches __host_dup —
#                         without it busybox cannot relocate the script fd
#                         and dies at startup ("Invalid argument").
# - wasi-sdk ships real crt/libc files, so the zig cache-probing below is
#   unnecessary there; but the setjmp rt.o must still come from wasi-libc's
#   musl setjmp/wasm32/rt.c compiled with the EH flags (nothing ships it
#   pre-built for the EH-sjlj configuration). No current toolchain ships that
#   source either, so it is fetched and pinned like the busybox tarball.
# - Note that only zig works as a toolchain in practice: busybox's libbb.h
#   needs netdb.h, paths.h, pwd.h, grp.h, sys/wait.h and termios.h, and zig
#   supplies all six from lib/libc/include/generic-musl. The wasi-sdk sysroot
#   has none of them, so that path needs vendored headers to build.
set -e
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/.." && pwd)
work="$here/work"

BB_VER=1.38.0
BB_TARBALL="busybox-${BB_VER}.tar.bz2"
BB_SHA256=34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2
BB="$work/busybox-${BB_VER}"

# Fallback source for musl's setjmp rt.c — see the rt.o step below for why it
# is fetched rather than taken from the toolchain.
WASI_LIBC_TAG=wasi-sdk-33
RT_SHA256=1d12042174aa55f4b24b2df235b1a0b72893a6cb791f297a4d772e543123e1b7

PLAIN=no; TOOLCHAIN=auto; KEEP=no; DEBUG=no
while [ $# -gt 0 ]; do
	case "$1" in
		--plain) PLAIN=yes;;
		--toolchain) TOOLCHAIN="$2"; shift;;
		--keep) KEEP=yes;;
		--debug) DEBUG=yes;;
		*) echo "unknown arg: $1" >&2; exit 2;;
	esac
	shift
done

# --- toolchain selection ------------------------------------------------------
if [ "$TOOLCHAIN" = auto ]; then
	if command -v zig >/dev/null 2>&1; then TOOLCHAIN=zig
	elif python3 -c 'import ziglang' 2>/dev/null; then TOOLCHAIN=ziglang
	elif [ -n "${WASI_SDK_PATH:-}" ] && [ -x "$WASI_SDK_PATH/bin/clang" ]; then TOOLCHAIN=wasi-sdk
	else
		cat >&2 <<'EOT'
No wasm32-wasi toolchain found. Install ONE of:
  - zig               (brew install zig | https://ziglang.org/download)
  - ziglang via pip   (pip3 install ziglang)
  - wasi-sdk          (https://github.com/WebAssembly/wasi-sdk) + export WASI_SDK_PATH
then re-run build/build.sh.
EOT
		exit 1
	fi
fi
case "$TOOLCHAIN" in
	zig)      ZIG="zig";;
	ziglang)  ZIG="python3 -m ziglang";;
	wasi-sdk) ZIG="";;
	*) echo "unknown --toolchain: $TOOLCHAIN" >&2; exit 2;;
esac
echo "toolchain: $TOOLCHAIN"

# --- fetch + verify + pristine extract ----------------------------------------
mkdir -p "$work"
if [ ! -f "$work/$BB_TARBALL" ]; then
	echo "fetching $BB_TARBALL…"
	curl -sSfLo "$work/$BB_TARBALL" "https://busybox.net/downloads/$BB_TARBALL"
fi
echo "$BB_SHA256  $work/$BB_TARBALL" | shasum -a 256 -c -
rm -rf "$BB"
tar -C "$work" -xjf "$work/$BB_TARBALL"

# --- source edits ---------------------------------------------------------------
# mode_string.c ships a `#define mode_t unsigned short` size hack behind an
# S_IF* preprocessor check; when the target libc's S_IF values trip it, the
# define conflicts with the real bb_mode_string prototype. Removing it is a
# no-op when the check wouldn't fire (perl just finds no match).
perl -0777 -i -pe 's/^#\s*if \(S_IRWXU.*?== 07777\n#\s*undef mode_t\n#\s*define mode_t unsigned short\n#\s*endif\n//ms' "$BB/libbb/mode_string.c"

# The fork-free ash patch: run $(...) and builtin pipelines in-process through
# the __host_pipe-backed in-memory pipes, with subshell isolation built from
# ash's own local-variable machinery.
if [ "$PLAIN" = no ]; then
	patch -p1 -d "$BB" < "$here/ash-forkfree.patch"
fi

# Host builtins: let the embedder register JS-backed command names (see
# build/shim/wasistubs.c's host_builtin_* wrappers and src/shim.mjs). Applied
# UNCONDITIONALLY — it needs none of the fork-free machinery, and it also fixes
# a crash that exists either way: a slashed command name (`/bin/php`, `./x.sh`)
# reaches vforkexec(), vfork() is ENOSYS, and ash aborts the whole script with
# "can't fork" and status 2 instead of reporting 127.
patch -p1 -d "$BB" < "$here/ash-hostbuiltin.patch"

# Shebang dispatch, and `env` as a shell builtin rather than the applet. Also
# UNCONDITIONAL, but it does depend on ash-hostbuiltin.patch above: it hooks
# the same slash short circuit, and the interpreter it re-dispatches is usually
# a host builtin. Pairs with CONFIG_ENV=n in busybox.config — the applet ends
# in execve(), which is ENOSYS here.
patch -p1 -d "$BB" < "$here/ash-shebang.patch"

# A shell that survives being run inside a shell. Depends on ash-shebang.patch
# only in the sense that it is what makes `#!/bin/sh` worth resolving; the bug
# it fixes (a nested `sh` ends the whole instance) is reachable by typing.
patch -p1 -d "$BB" < "$here/ash-nested-shell.patch"


# Cooperative interrupt, applet side: run_nofork_applet arms a baseline, and
# the safe points (wrapped read/write/readv/writev below, plus awk's and sed's
# own loops) bail through die_func with 130 when the host's count has moved.
# Also UNCONDITIONAL: it needs nothing from the two patches above and its
# context avoids every line they touch, so --plain applies it just the same.
patch -p1 -d "$BB" < "$here/applet-interrupt.patch"

# The "#!" rule, extended to the PATH search. Applied LAST so no earlier patch
# has to apply over it: it edits find_command(), which ash-hostbuiltin.patch
# also touches, and shebang_expand(), which ash-shebang.patch introduces.
patch -p1 -d "$BB" < "$here/ash-shebang-path.patch"

# --- configure (ash-only + LFS + read-frac + math-base) ------------------------
cp "$here/busybox.config" "$BB/.config"
yes "" | make -C "$BB" oldconfig HOSTCC=cc >/dev/null

# libbb's socket helpers don't compile against wasi-libc (no getsockname, no
# sockaddr_un.sun_path) and the ash-only config never links them — drop them
# from the object list instead of letting them abort the libbb build.
# (Kbuild.src, not Kbuild: make regenerates the latter from the former.)
sed -i.orig '/lib-y += xconnect\.o/d' "$BB/libbb/Kbuild.src"

# --- compiler wrappers ----------------------------------------------------------
SHIM="$here/shim"
CFLAGS_WASM="-mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  -fno-sanitize=all \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID \
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_GNU_SOURCE -DSOCK_RDM=4 \
  -include $SHIM/wasi_compat.h -I$SHIM \
  -Wno-implicit-function-declaration -Wno-int-conversion -Wno-error"

if [ "$TOOLCHAIN" = wasi-sdk ]; then
	CC_CMD="$WASI_SDK_PATH/bin/clang --target=wasm32-wasi $CFLAGS_WASM"
	WASM_LD="$WASI_SDK_PATH/bin/wasm-ld"
	AR_CMD="$WASI_SDK_PATH/bin/llvm-ar"
else
	CC_CMD="$ZIG cc --target=wasm32-wasi $CFLAGS_WASM"
	WASM_LD="$ZIG wasm-ld"
	AR_CMD="$ZIG ar"
fi

cat > "$work/zcc" <<WRAP
#!/bin/sh
exec $CC_CMD "\$@"
WRAP
# kbuild's per-dir `ld -r` -> wasm-ld --relocatable, minus flags it rejects.
cat > "$work/zld" <<WRAP
#!/bin/sh
a=""; for x in "\$@"; do case "\$x" in -r|-nostdlib|-m|elf_*) ;; *) a="\$a \$x";; esac; done
exec $WASM_LD --relocatable \$a
WRAP
chmod +x "$work/zcc" "$work/zld"
export PATH="$work:$PATH"

# --- compile --------------------------------------------------------------------
cores=$( (nproc || sysctl -n hw.ncpu || echo 4) 2>/dev/null | head -1 )
# The make-driven FINAL link fails on a zig-cc EH-tag quirk; every object still
# builds, and we do the final link by hand below. Output lands in make.log and
# the guard below refuses to link from a half-built tree.
make -C "$BB" -j"$cores" CC=zcc LD=zld HOSTCC=cc AR="$AR_CMD" \
     SKIP_STRIP=y > "$work/make.log" 2>&1 || true
for need in "$BB/libbb/lib.a" "$BB/shell/lib.a" "$BB/libbb/appletlib.o" "$BB/applets/applets.o"; do
	[ -f "$need" ] || { echo "compile failed: missing $need — see $work/make.log" >&2; exit 1; }
done

# --- nested-shell state guard ---------------------------------------------------
# ASH_STATE_LIST() in ash-nested-shell.patch has to name every mutable global in
# ash.c: one it misses is state a nested shell silently takes from its caller,
# which surfaces later as a script doing something odd that nobody connects back
# to a `sh` three lines earlier.
#
# Ask the COMPILER what the file has, not a regex over the source. Clang names
# each static `internal global` in LLVM IR and read-only data `internal
# constant`, having already resolved every #if — so this needs no knowledge of
# which config symbols are on. Reading the source was tried first and was worse
# than useless: it matched only declarations ending in `;`, so every static with
# a trailing comment was invisible (three were), and a function-local static was
# invisible by construction (two were) — while reporting no drift.
#
# -O0 so that nothing is optimised away, -w because warnings are the make step's
# business, and the flags are kbuild's minus the ones that cannot change which
# globals exist.
echo "checking ash's mutable globals against ASH_STATE_LIST()…"
( cd "$BB" && zcc -std=gnu99 -Iinclude -Ilibbb -include include/autoconf.h \
	-D_GNU_SOURCE -DNDEBUG -DBB_VER='"'"$BB_VER"'"' \
	-DKBUILD_BASENAME='"ash"' -DKBUILD_MODNAME='"ash"' \
	-w -O0 -S -emit-llvm -o "$work/ash.ll" shell/ash.c ) \
  || { echo "could not emit LLVM IR for shell/ash.c" >&2; exit 1; }
sed -n 's/^@\([A-Za-z_][A-Za-z0-9_.]*\) = internal [a-z_ ]*global .*/\1/p' \
  "$work/ash.ll" | sort -u > "$work/ash-globals"
sed -n '/^\/\* ============ Nested shells/,/^struct ash_state {/p' "$BB/shell/ash.c" \
  | grep -o 'F([A-Za-z_][A-Za-z0-9_]*)' | sed 's/F(\(.*\))/\1/' | sort -u > "$work/ash-state"
# ash_nest_depth is the nesting counter itself: it MUST survive the restore.
missing=$(comm -23 "$work/ash-globals" "$work/ash-state" | grep -vx 'ash_nest_depth' || true)
if [ -n "$missing" ]; then
	echo "ash.c has mutable globals that ASH_STATE_LIST() does not name:" >&2
	echo "$missing" | sed 's/^/  /' >&2
	case "$missing" in *.*)
		echo "A name of the form FUNC.VAR is a function-local static, which" >&2
		echo "cannot be named in the list at all — hoist it to file scope." >&2 ;;
	esac
	echo "A nested shell would take these from its caller. See" >&2
	echo "build/ash-nested-shell.patch." >&2
	exit 1
fi
echo "  $(wc -l < "$work/ash-globals") mutable globals, all accounted for"

# --- shim objects + setjmp runtime ---------------------------------------------
zcc -O2 -c "$SHIM/wasistubs.c" -o "$work/wasistubs.o"
zcc -O2 -c "$SHIM/ppoll.c"     -o "$work/ppoll.o"
if [ "$TOOLCHAIN" = ziglang ]; then
	ZLROOT=$(python3 -c "import ziglang,os;print(os.path.dirname(ziglang.__file__))")/lib
elif [ "$TOOLCHAIN" = zig ]; then
	# `zig env` prints JSON (<=0.13: "lib_dir": "...") or ZON (0.14+:
	# .lib_dir = "..."); match either.
	ZLROOT=$(zig env 2>/dev/null \
	  | sed -n -e 's/.*"lib_dir": *"\([^"]*\)".*/\1/p' \
	           -e 's/.*\.lib_dir = "\([^"]*\)".*/\1/p' | head -1)
	if [ -z "$ZLROOT" ] || [ ! -d "$ZLROOT" ]; then
		echo "could not locate zig's lib dir via 'zig env'" >&2; exit 1
	fi
else
	ZLROOT=""
fi

# rt.c used to come out of the toolchain's own wasi-libc tree, but no shipping
# toolchain still has it: zig 0.13/0.14/0.15 bundle only a trimmed musl subset
# with no src/setjmp at all, and wasi-sdk never shipped it (it has no prebuilt
# rt.o for the EH-sjlj configuration either). So prefer the in-tree copy if a
# toolchain ever carries one again, and otherwise fetch it — pinned to a tag
# and SHA-256 verified, like the busybox tarball above, so the build stays
# reproducible.
RT_SRC="$ZLROOT/libc/wasi/libc-top-half/musl/src/setjmp/wasm32/rt.c"
if [ -z "$ZLROOT" ] || [ ! -f "$RT_SRC" ]; then
	RT_SRC="$work/rt.c"
	if [ ! -f "$RT_SRC" ]; then
		echo "fetching setjmp rt.c…"
		curl -sSfLo "$RT_SRC" \
		  "https://raw.githubusercontent.com/WebAssembly/wasi-libc/${WASI_LIBC_TAG}/libc-top-half/musl/src/setjmp/wasm32/rt.c"
	fi
	echo "$RT_SHA256  $RT_SRC" | shasum -a 256 -c -
fi
zcc -O2 -c "$RT_SRC" -o "$work/rt.o"

# --- final link ------------------------------------------------------------------
if [ "$TOOLCHAIN" = wasi-sdk ]; then
	CRT="$WASI_SDK_PATH/share/wasi-sysroot/lib/wasm32-wasi/crt1-command.o"
	LIBC="$WASI_SDK_PATH/share/wasi-sysroot/lib/wasm32-wasi/libc.a"
	RTLIB=$(ls "$WASI_SDK_PATH"/lib/clang/*/lib/wasi/libclang_rt.builtins-wasm32.a 2>/dev/null | head -1)
	EXTRA_LIBS="$LIBC $RTLIB"
else
	# zig generates crt/libc/compiler_rt on demand; capture their cache paths
	# from a verbose throwaway link (zig 0.16 dropped -### output).
	echo 'int main(void){return 0;}' > "$work/zprobe.c"
	$ZIG cc --target=wasm32-wasi "$work/zprobe.c" -o "$work/zprobe.wasm" -v \
	  > "$work/zprobe.log" 2>&1 || { cat "$work/zprobe.log" >&2; exit 1; }
	probe(){ tr ' "' '\n\n' < "$work/zprobe.log" | grep "$1" | head -1; }
	CRT=$(probe crt1-command.o); LIBC=$(probe '/libc.a')
	ZIGC=$(probe libzigc.a); RTLIB=$(probe libcompiler_rt.a)
	if [ -z "$CRT" ] || [ -z "$LIBC" ]; then
		echo "failed to locate zig's wasm32-wasi crt/libc (see $work/zprobe.log)" >&2; exit 1
	fi
	EXTRA_LIBS="$LIBC $ZIGC $RTLIB"
fi

# --wrap exit: raw exit() inside an in-process applet must return to the
#   shell instead of killing the instance — wasistubs' __wrap_exit routes it
#   through busybox's die_func (see the applet notes in ARCHITECTURE.md).
# --wrap ioctl: TIOCGWINSZ (stty size / get_terminal_width_height) reads the
#   live terminal geometry from the host winsize slot; wasistubs' __wrap_ioctl
#   answers it and returns ENOTTY for any other request (busybox needs no other
#   ioctl once size works — modes go through tcgetattr/tcsetattr). --wrap avoids
#   colliding with wasi-libc's own ioctl symbol.
# --wrap poll: the chokepoint for a synthesized SIGWINCH. tuish's `read -t`
#   waits in poll(); __wrap_poll runs winch_dispatch() after every poll so a
#   host-posted resize fires ash's captured WINCH handler. Covers ppoll.c too
#   (its poll() call is wrapped as well).
# --wrap read/write/readv/writev: the safe points of the cooperative interrupt.
#   read/write carry libbb's own loops (safe_read, full_write) and readv/writev
#   carry stdio's — wasi-libc's __stdio_write goes through writev, so wrapping
#   write alone leaves everything that printf()s uninterruptible. Wrapped at
#   libc so no applet needs an edit; see wasistubs.c's bb_intr_check().
#
# --strip-debug: DWARF dominated this binary — about 1.05 MB of a 1.55 MB
#   module, two thirds of what every browser had to download, for debug info
#   describing busybox internals that no consumer of this package steps
#   through. It also embedded the absolute build paths of whoever ran the
#   script. The `name` section is deliberately kept (~15 KB): it costs little
#   and keeps wasm stack traces readable. Build with --debug to keep DWARF.
OUT="$work/busybox.wasm"
$WASM_LD --import-undefined --wrap fcntl --wrap exit --wrap ioctl --wrap poll \
  --wrap read --wrap write --wrap readv --wrap writev \
  --wrap __wasilibc_fd_renumber \
  $([ "$DEBUG" = yes ] || echo --strip-debug) \
  "$CRT" "$BB/libbb/appletlib.o" "$BB/applets/applets.o" \
  $(find "$BB" -name built-in.o | sort) $(find "$BB" -name lib.a | sort) \
  "$work/wasistubs.o" "$work/ppoll.o" "$work/rt.o" \
  $EXTRA_LIBS \
  -o "$OUT"
echo "linked: $OUT ($(wc -c < "$OUT") bytes)"

# --- smoke test: refuse to install a broken binary ------------------------------
node --input-type=module -e "
import { runScript } from '$pkg/src/node.mjs';
// Line 5 pins the host-builtin patch's two invariants WITHOUT registering any
// builtin: an unknown name is still a plain 127, and a SLASHED unknown name is
// too (before the patch it died with 'can't fork' and never reached the echo).
const r = await runScript('echo ok; x=\$(printf hi); echo \$x; echo \$((10#09)); seq 3 | grep -v 2 | tail -n 1; nosuch 2>/dev/null; echo n=\$?; /bin/nosuch 2>/dev/null; echo s=\$?', { wasm: '$OUT' });
if (r.stdout !== 'ok\nhi\n9\n3\nn=127\ns=127\n' || r.exitCode !== 0) {
  console.error('SMOKE TEST FAILED:', JSON.stringify(r));
  process.exit(1);
}
console.log('smoke test passed:', JSON.stringify(r.stdout));
"

# dist/ is not committed, so a clean checkout does not have it — create it
# rather than assuming a previous build or a tracked file left it behind.
mkdir -p "$pkg/dist"
cp "$OUT" "$pkg/dist/busybox.wasm"
echo "-> installed $pkg/dist/busybox.wasm"
[ "$KEEP" = yes ] || rm -rf "$BB"
echo
echo "Now run the full gate before trusting it:"
echo "  npm test                     (wasi-sh suite)"
echo "  node web/check.mjs           (tuish drift gate, from the tuish repo)"
