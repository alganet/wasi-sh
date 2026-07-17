#!/bin/sh
# Build dist/busybox.wasm from source: busybox ash as a PLAIN wasm32-wasi
# module with the fork-free command-substitution/pipe patch.
#
#   build/build.sh [--plain] [--toolchain zig|ziglang|wasi-sdk] [--keep]
#
#   --plain      skip ash-forkfree.patch (fork stays ENOSYS and every $( )
#                fails; you almost never want this)
#   --toolchain  zig      = a `zig` binary on PATH        (verified recipe)
#                ziglang  = `python3 -m ziglang` (pip install ziglang)
#                wasi-sdk = $WASI_SDK_PATH/bin/clang      (documented variant;
#                           same flags, simpler link — see notes below)
#   --keep       keep build/work/ around for inspection
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
#     --import-undefined  leaves the env.__host_* fd hooks as wasm imports
#                         (implemented by the JS shim);
#     --wrap fcntl        routes ash's fcntl() through wasistubs.c's
#                         __wrap_fcntl so F_DUPFD reaches __host_dup —
#                         without it busybox cannot relocate the script fd
#                         and dies at startup ("Invalid argument").
# - wasi-sdk ships real crt/libc files, so the zig cache-probing below is
#   unnecessary there; but the setjmp rt.o must still come from wasi-libc's
#   musl setjmp/wasm32/rt.c compiled with the EH flags (wasi-sdk does not
#   ship it pre-built for the EH-sjlj configuration).
set -e
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(cd "$here/.." && pwd)
work="$here/work"

BB_VER=1.38.0
BB_TARBALL="busybox-${BB_VER}.tar.bz2"
BB_SHA256=34f9ea6ff8636f2c9241153b9114eefa9e65674a45318ae1ef95bb5f31c53bb2
BB="$work/busybox-${BB_VER}"

PLAIN=no; TOOLCHAIN=auto; KEEP=no
while [ $# -gt 0 ]; do
	case "$1" in
		--plain) PLAIN=yes;;
		--toolchain) TOOLCHAIN="$2"; shift;;
		--keep) KEEP=yes;;
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

# --- shim objects + setjmp runtime ---------------------------------------------
zcc -O2 -c "$SHIM/wasistubs.c" -o "$work/wasistubs.o"
zcc -O2 -c "$SHIM/ppoll.c"     -o "$work/ppoll.o"
if [ "$TOOLCHAIN" = ziglang ]; then
	ZLROOT=$(python3 -c "import ziglang,os;print(os.path.dirname(ziglang.__file__))")
	RT_SRC="$ZLROOT/lib/libc/wasi/libc-top-half/musl/src/setjmp/wasm32/rt.c"
elif [ "$TOOLCHAIN" = zig ]; then
	# `zig env` prints JSON (<=0.13: "lib_dir": "...") or ZON (0.14+:
	# .lib_dir = "..."); match either.
	ZLROOT=$(zig env 2>/dev/null \
	  | sed -n -e 's/.*"lib_dir": *"\([^"]*\)".*/\1/p' \
	           -e 's/.*\.lib_dir = "\([^"]*\)".*/\1/p' | head -1)
	if [ -z "$ZLROOT" ] || [ ! -d "$ZLROOT" ]; then
		echo "could not locate zig's lib dir via 'zig env'" >&2; exit 1
	fi
	RT_SRC="$ZLROOT/libc/wasi/libc-top-half/musl/src/setjmp/wasm32/rt.c"
else
	# wasi-sdk: rt.c is not shipped; fetch the matching wasi-libc source once.
	RT_SRC="$work/rt.c"
	[ -f "$RT_SRC" ] || curl -sSfLo "$RT_SRC" \
	  "https://raw.githubusercontent.com/WebAssembly/wasi-libc/main/libc-top-half/musl/src/setjmp/wasm32/rt.c"
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
OUT="$work/busybox.wasm"
$WASM_LD --import-undefined --wrap fcntl --wrap exit --wrap ioctl --wrap poll \
  "$CRT" "$BB/libbb/appletlib.o" "$BB/applets/applets.o" \
  $(find "$BB" -name built-in.o | sort) $(find "$BB" -name lib.a | sort) \
  "$work/wasistubs.o" "$work/ppoll.o" "$work/rt.o" \
  $EXTRA_LIBS \
  -o "$OUT"
echo "linked: $OUT ($(wc -c < "$OUT") bytes)"

# --- smoke test: refuse to install a broken binary ------------------------------
node --input-type=module -e "
import { runScript } from '$pkg/src/node.mjs';
const r = await runScript('echo ok; x=\$(printf hi); echo \$x; echo \$((10#09)); seq 3 | grep -v 2 | tail -n 1', { wasm: '$OUT' });
if (r.stdout !== 'ok\nhi\n9\n3\n' || r.exitCode !== 0) {
  console.error('SMOKE TEST FAILED:', JSON.stringify(r));
  process.exit(1);
}
console.log('smoke test passed:', JSON.stringify(r.stdout));
"

cp "$OUT" "$pkg/dist/busybox.wasm"
echo "-> installed $pkg/dist/busybox.wasm"
[ "$KEEP" = yes ] || rm -rf "$BB"
echo
echo "Now run the full gate before trusting it:"
echo "  npm test                     (wasi-sh suite)"
echo "  node web/check.mjs           (tuish drift gate, from the tuish repo)"
