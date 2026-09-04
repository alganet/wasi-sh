// Minimal WASI preview1 shim for the busybox ash wasm module: the imports
// busybox uses plus the env.__host_pipe/__host_dup/__host_dup2 hooks that back
// its fork-free pipes and fd juggling (see build/shim/wasistubs.c). The
// filesystem is pluggable (`fs`) and defaults to memoryFs(files): mounted
// `files` plus anything the guest creates (O_CREAT needs an existing parent
// dir), copy-on-write over the caller's buffers, all of it gone with the run.
// In-memory pipes included, and /dev/null is the shim's, not the store's.
// Stdin is pluggable (`input`) so the same shim serves scripted runs (fixed
// queue) and interactive sessions (SAB ring + Atomics.wait) in any JS
// environment.
//
// The `input` contract:
//   pollReadable(ms) -> bool     data available (waiting up to ms for some;
//                                ms null = wait indefinitely, which is what an
//                                untimed guest poll does — see poll_oneoff)
//   read(max)        -> bytes    non-blocking, possibly empty
//   readBlocking?(max) -> bytes  park until data or EOF (worker threads only)
//   wait?(ms)                    sleep for a poll timeout
//   closed?()        -> bool     no more data will ever arrive (stdin EOF)
//   winchPending?()  -> bool     a resize is queued (peek; takeWinch consumes).
//                                Its presence is what tells poll_oneoff the
//                                input can park indefinitely and be woken by
//                                something other than bytes.
//   interruptCount?() -> int     cooperative interrupts posted so far. A count,
//                                not a flag: work in flight reads it once at
//                                entry and compares, so nothing has to consume
//                                it and an interrupt posted while nothing is
//                                running cannot cancel the next thing that is.
//
// The `fs` contract is a third seam of the same kind (see fs.mjs): a
// path-addressed synchronous store in ZenFS's `FileSystem` shape. Everything
// the store does not own stays here — open file descriptions and their shared
// offsets, and the device overlay — so a store can be a real directory, a
// SharedArrayBuffer or somebody else's filesystem without knowing any of it.
//
// Host builtins are pluggable the same way (`builtins`), extending the shell's
// command namespace with JS-backed names — in-process, argv in, status out,
// exactly like a busybox applet and just as much NOT a process:
//   lookup(name) -> bool         is this a host builtin? (must not run it —
//                                find_command, `type` and `command -v` ask)
//   run(ctx)     -> status       execute it, SYNCHRONOUSLY
// ctx is { argv, env, cwd, stdin(max), stdout(bytes), stderr(bytes), fs,
// interrupted() }.
// Absent, the shell behaves byte-for-byte as it did before.
//
// The `net` port is the fifth seam, and the only one the guest cannot do
// without: WASI preview1 has `sock_recv`/`sock_send` for descriptors it was
// already given and no way at all to originate a connection, so socket() and
// connect() come from here or not at all. Three calls, and the reading and
// writing is fd_read/fd_write like any other descriptor:
//   resolve(name) -> dotted quad | null
//   connect(addr, port) -> handle        (throwing refuses it)
//   send/recv/poll/close(handle, ...)
//   recvAsync?(handle, max) -> Promise   optional; see below
// Absent, socket() is EAFNOSUPPORT and nothing else changes.
//
// `recvAsync` is the same answer `recv` gives, once there is one to give. Where
// the engine has JSPI and the net offers it, a guest reading a socket suspends
// instead of owning the thread for the length of a download — which is the same
// trade `suspendInput` makes for a keystroke, and matters for the same reason:
// the thread a guest holds is the thread everything else in that worker is
// answered on. A net without it is read synchronously, as it always was.
//
// The `host` port is the fourth seam, and the one aimed outward — at the
// browser rather than at the shell. One capability object, one virtual device,
// verbs instead of per-feature plumbing:
//   request(verb, payload) -> bytes    execute a verb, SYNCHRONOUSLY
// Reached from a script as /dev/host (see hostDevice()); absent, the device is
// there and every open is EPERM.
//
// The port runs both ways. Inbound — the HOST asking the GUEST — is `requests`,
// an input-shaped channel of request lines read from /dev/hostreq, which is how
// a dev server is an ordinary shell loop:
//   while read -r req <&3; do handle "$req"; done 3< /dev/hostreq
// A running guest owns its worker, so nothing outside it can be delivered by
// postMessage; the channel is shared memory the guest reads at a blocking
// point. End-of-stream is EOF (the loop ends), and a session that can never
// receive requests refuses the open (the loop never starts).
//
// Usage:
//   const shim = new WasiShim({ args, env, files, stdout, stderr, input, builtins });
//   const { instance } = await WebAssembly.instantiate(module, shim.imports());
//   shim.bindMemory(instance.exports.memory);
//   try { instance.exports._start(); } catch (e) { if (!(e instanceof WasiExit)) throw e; }

import { memoryFs, normalize, isDir, isChar, S_IFDIR, S_IFREG, S_IFCHR, DEFAULT_DIR_MODE, DEFAULT_FILE_MODE } from './fs.mjs';

export class WasiExit extends Error { constructor(code){ super('exit '+code); this.code=code; } }

// What every creation hands the store. The contract's shape is ZenFS's, and
// ZenFS makes uid, gid and mode REQUIRED at creation — so `{}` is not "take
// your defaults", it is a mode of zero, and a store entitled to take that
// literally produced a tree with no permission bits on anything.
//
// busybox never noticed: it is alone in there and the shim enforces nothing.
// The contract exists so a SECOND guest can share the store, and the first one
// to try could not read a byte of it — PHP stats the shell's own file, gets
// EACCES, and reports it as a 404 for a script that is right there. uid/gid 0
// because a guest here is root and there is nobody else to be.
// Frozen because one object serves every creation: a store that kept a
// reference and wrote through it would be editing the defaults for the rest of
// the session, and ZenFS's own type is Readonly for the same reason.
const NEW_FILE = Object.freeze({ mode: DEFAULT_FILE_MODE, uid: 0, gid: 0 });
const NEW_DIR = Object.freeze({ mode: DEFAULT_DIR_MODE, uid: 0, gid: 0 });

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const EMPTY = new Uint8Array(0);

const errnoName = (n) => Object.keys(E).find((k) => E[k] === n) || String(n);
const E = { SUCCESS:0, BADF:8, EXIST:20, INTR:27, INVAL:28, IO:29, ISDIR:31, NOENT:44, NOSPC:51, NOSYS:52, NOTDIR:54, NOTEMPTY:55, PERM:63, NOTCAPABLE:76, AGAIN:6, SPIPE:70 };
const FT = { CHAR:2, DIR:3, REG:4 };
// FD_SEEK (bit 2) | FD_TELL (bit 5) of the WASI rights word. Their ABSENCE on a
// character device is how wasi-libc's isatty() recognizes a terminal, so these
// are exactly the rights a tty fd must not claim.
const RIGHTS_NOT_A_TTY = (1n << 2n) | (1n << 5n);

// Stores speak LINUX errno; WASI numbers its own list alphabetically. The two
// overlap enough to look interchangeable and disagree exactly where it hurts —
// Linux ENOENT 2 is WASI EACCES, which is how the same confusion in the other
// direction made a missing file report "Permission denied" downstream. An
// unrecognized failure is EIO: the store broke in a way we cannot name.
// Every code fs.mjs's ERRNO publishes is here: a store told to speak that
// vocabulary and then translated to EIO would be worse off for having been
// precise.
const WASI_ERRNO = {
  EPERM:63, ENOENT:44, EIO:29, EBADF:8, EACCES:2, EBUSY:10, EEXIST:20, EXDEV:75,
  ENOTDIR:54, EISDIR:31, EINVAL:28, ENFILE:41, EMFILE:33, ENOSPC:51, EROFS:69,
  EMLINK:34, ENOSYS:52, ENOTEMPTY:55, ELOOP:32, ENAMETOOLONG:37,
  EAGAIN:6, ENOMEM:48, EFBIG:22, ESPIPE:70, EPIPE:64,
  // What a socket fails with. WASI numbers its errnos alphabetically,
  // so these are nowhere near their Linux values and guessing is how a
  // refused connection gets reported as something else entirely.
  ECONNREFUSED:14, ECONNRESET:15, EHOSTUNREACH:23, EAFNOSUPPORT:5,
};
const wasiErrno = (err) => WASI_ERRNO[err && err.code] ?? E.IO;

// Devices belong to the shim, never to the store: mounting a real directory
// must not mean writing device nodes into it, and a read-only store must not
// lose /dev/null. They shadow the store's own /dev if it has one, and they sit
// on a different st_dev so their inodes cannot collide with its.
//
// One registration, one source of truth. The inode used to come from a
// hard-coded table beside the map `ls /dev` enumerates, so the two could
// disagree about what exists — and a device added to the map alone would LIST
// but never OPEN, because deviceStat() is where every path op starts. Nothing
// warns; the name is simply there and unusable. addDevice() is the only way in
// now, and it hands out the inode itself.
const DEV_DEV = 2n;
const DEV_DIR_INO = 1;
const DEV_NULL = { read:()=>EMPTY, write:()=>{} };
// A device read answers with BYTES or with an ERRNO — the same two-shape
// vocabulary its write already speaks (an errno to refuse, nothing to accept).
// A number is an errno; anything else is data. Needed because a device that
// can block has to be able to say EAGAIN, which bytes cannot express: an empty
// read means EOF, and a device with more to come later must not claim it.
const devRead = (r) => (typeof r === 'number' ? { data:EMPTY, errno:r } : { data:r||EMPTY, errno:0 });

// What one exchange may hold: a request line waiting for its terminating
// newline, and answers waiting to be read. Neither is a tuning knob — both are
// there because a script can write without bound and never read. `yes >
// /dev/host` completes no request and grows the first; a loop of real requests
// nobody reads grows the second. Either would run until the tab dies.
const HOST_LINE_MAX = 1 << 20;
const HOST_QUEUE_MAX = 1 << 24;

export class WasiShim {
  constructor({ args=['busybox'], env={}, files={}, fs, stdout, stderr, beforeBlock, input, builtins, host, net, requests, tty=false, suspendable=false, suspendInput=false }) {
    this.args = args;
    this.env = Object.entries(env).map(([k,v]) => `${k}=${v}`);
    this.stdout = stdout || (() => {});
    this.stderr = stderr || this.stdout;
    // "I am about to stop writing." Called immediately before the guest hands
    // the thread away, at every point where it can: the two reads, the three
    // polls, and every call out to embedder code — a host builtin and a
    // /dev/host verb alike.
    //
    // It exists for output. A caller that BATCHES what stdout and stderr hand
    // it has to know when the batch is finished, and the only honest answer is
    // "when the guest stops writing": the prompt is the last thing written
    // before a shell parks on a keystroke, so a batch that waits for a timer
    // instead would leave the terminal blank until one fired. See serve()'s
    // writer in worker.mjs, which is the caller this is for.
    //
    // The calls out are here for a second reason, and it is ORDERING, not
    // latency. A handler is free to postMessage to the page itself — the
    // host-port example answers a request that way — and a batch still being
    // held when it does lets that message overtake output the guest wrote
    // BEFORE the call. Measured with the example: both responses arrived ahead
    // of every line of the script that produced them.
    //
    // No-op by default, so a shim used directly — every twin in test/ — writes
    // through as it always did.
    this.beforeBlock = typeof beforeBlock === 'function' ? beforeBlock : null;
    this.input = input;                 // { pollReadable(ms)->bool, read(max)->Uint8Array }
    this.builtins = builtins;           // { lookup(name)->bool, run(ctx)->status }
    // The fifth seam, and the one aimed at the network. Absent, socket() is
    // EAFNOSUPPORT and nothing else changes — which is what every session that
    // does not ask for one still gets.
    //   resolve(name)        -> dotted-quad string | null
    //   connect(addr, port)  -> handle            (throws to refuse)
    //   send(handle, bytes)  -> count
    //   recv(handle, max)    -> Uint8Array | AGAIN sentinel
    //   poll(handle)         -> { readable, writable, hup }
    //   close(handle)
    this.net = net;
    // May a host builtin await? Feature-detected rather than trusted, so an
    // embedder that asks for it on an engine without JSPI gets the shell it
    // always had and a clear refusal the first time a handler returns a
    // promise — not a session that fails to instantiate. Read back by the
    // caller (run(), serve()) to decide whether to enter through
    // WebAssembly.promising, which is the other half and useless alone.
    this.suspendable = !!suspendable
      && typeof WebAssembly.Suspending === 'function'
      && typeof WebAssembly.promising === 'function';
    // The same JSPI machinery, pointed at the WAIT rather than at the call
    // out. A guest parked on a keystroke owns the thread, and the event loop
    // under it stops — so a shell that draws its own prompt and a host that
    // wants to be called cannot both exist. Suspended, the guest's stack is
    // set aside and the thread goes back to its queue until bytes arrive.
    //
    // Both async methods are required, not one: the read path and the poll
    // path each have their own, and an input with half of them would take the
    // suspending branch in one place and block in the other.
    this.suspendInput = !!suspendInput && this.suspendable
      && !!(input && input.readBlockingAsync && input.pollReadableAsync);
    // The same trade, on the other blocking descriptor there is. Not gated on
    // `suspendInput`: the two are independent — a session may have a net that
    // can be awaited and an input that cannot — and both are feature-detected
    // off the port rather than asked for, because an embedder cannot know
    // whether the net it was handed has an awaited door.
    //
    // A socket read is the longer of the two waits by far. A keystroke arrives
    // when someone presses a key; a download takes as long as the network says,
    // and for the whole of it a parked guest answers nothing.
    this.suspendNet = this.suspendable && !!(net && typeof net.recvAsync === 'function');
    // Set only for the length of the delegated call inside that wrapper; read
    // by poll_oneoff, which must not park a second time on a wait already
    // spent. Declared here so the field exists before anything reads it.
    this.pollAlreadyWaited = false;
    this.host = host;                   // { request(verb, payload)->bytes } — see hostDevice()
    this.requests = requests;           // inbound: an `input`-shaped channel of request lines
    this.mem = null; this.view = null; this.u8 = null;
    // The filesystem, as a store (see fs.mjs). Passing one is how a session
    // reaches a real directory or a shared buffer; passing none keeps today's
    // sealed in-memory sandbox. `files` seeds the default store — and is
    // written THROUGH an injected one, because asking for both is explicit.
    // Refuse up front rather than write a file to a name `ls /dev` will never
    // show. Every other write path is guarded; seeding must be too, and saying
    // so beats mounting something that silently cannot be read back.
    for (const path of Object.keys(files || {})) {
      const abs = normalize(path.startsWith('/') ? path : `/${path}`);
      if (ownsDevPath(abs)) throw new Error(`files: '${abs}' is under /dev, which is the shim's device overlay — the file would be mounted and then hidden by it`);
    }
    this.store = fs || memoryFs(files);
    if (fs) seedInto(this.store, files);
    this.bootMs = Date.now();
    this.devices = new Map();
    this.nextDevIno = DEV_DIR_INO + 1;
    this.addDevice('/dev/null', DEV_NULL);
    // Registered whether or not a port was handed over: "this session did not
    // grant it" (EPERM) and "this build has no port at all" (ENOENT) are
    // different answers, and a script can only act on the difference if the
    // name is there to be refused.
    this.addDevice('/dev/host', this.hostDevice());
    // Registered on the same terms, and granted separately: a session may be
    // able to ask the host without being able to be asked, and the two are not
    // the same capability. Without a channel the name is there and every open
    // is EPERM, so a dev-server loop refuses to start instead of parking on a
    // request that can never arrive.
    this.addDevice('/dev/hostreq', this.requestDevice());
    // fd table. 0/1/2 std, 3 = preopen "/".
    //
    // `tty` is what makes isatty() true on them, and isatty() is the whole gate
    // on ash's own line editor: shell/ash.c sets `iflag` only when isatty(0)
    // AND isatty(1), and without iflag it never calls read_line_input() — so
    // there is no prompt, no echo, no history, no arrow keys and no tab
    // completion, whatever libbb/lineedit.c was compiled with. Measured: with
    // the bit on and nothing else changed, the banner and the `# ` prompt
    // appear and the guest echoes its own keystrokes in raw mode.
    //
    // OFF by default, and that is a compatibility decision rather than a
    // preference. An embedder that edits lines in the page — both of ours did,
    // and examples/repl.html is the pattern — holds the line until Enter and
    // echoes it itself, so a guest that also echoes prints every line twice.
    // Opting in with spawn({ tty: true }) is how a terminal says "the shell
    // owns the line", and run() never says it: a fixed stdin is not a terminal.
    this.fds = new Map();
    this.fds.set(0, { type:'stdin', tty });
    this.fds.set(1, { type:'stdout', tty });
    this.fds.set(2, { type:'stderr', tty });
    this.fds.set(3, { type:'dir', path:'/', preopen:true });
    this.nextFd = 4;
    this.pipes = [];
  }
  bindMemory(memory){ this.mem = memory; this.refresh(); }
  refresh(){ this.view = new DataView(this.mem.buffer); this.u8 = new Uint8Array(this.mem.buffer); }
  dv(){ if (this.view.buffer !== this.mem.buffer) this.refresh(); return this.view; }
  bytes(){ if (this.u8.buffer !== this.mem.buffer) this.refresh(); return this.u8; }

  imports(){
    const w = this;
    const p1 = {
      args_sizes_get:(cnt,sz)=>{ const b=w.args.map(strBytes); w.dv().setUint32(cnt,b.length,true); w.dv().setUint32(sz,b.reduce((a,x)=>a+x.length+1,0),true); return 0; },
      args_get:(av,buf)=>{ let p=buf; for(const a of w.args.map(strBytes)){ w.dv().setUint32(av,p,true); av+=4; w.bytes().set(a,p); p+=a.length; w.bytes()[p++]=0; } return 0; },
      environ_sizes_get:(cnt,sz)=>{ const b=w.env.map(strBytes); w.dv().setUint32(cnt,b.length,true); w.dv().setUint32(sz,b.reduce((a,x)=>a+x.length+1,0),true); return 0; },
      environ_get:(ev,buf)=>{ let p=buf; for(const a of w.env.map(strBytes)){ w.dv().setUint32(ev,p,true); ev+=4; w.bytes().set(a,p); p+=a.length; w.bytes()[p++]=0; } return 0; },
      // Clock 0 is REALTIME (wall clock); 1/2/3 (monotonic, cputimes) must
      // never step backwards, which Date.now() can — use performance.now().
      clock_time_get:(id,prec,out)=>{ const ns=BigInt(Math.round((id===0?Date.now():performance.now())*1e6)); w.dv().setBigUint64(out,ns,true); return 0; },
      // The one unambiguous flush point. A store that buffers — anything
      // persistent — has nowhere else to learn the run is over, and a failure
      // here is data loss, so it is reported rather than swallowed. It must
      // not replace the exit: the caller is waiting for a WasiExit.
      proc_exit:(code)=>{
        try { w.store.syncSync(); }
        catch(e) { w.stderr(strBytes(`wasi-sh: flushing the filesystem failed: ${(e&&e.message)||e}\n`)); }
        throw new WasiExit(code);
      },
      sched_yield:()=>0,
      random_get:(buf,len)=>{ const a=w.bytes().subarray(buf,buf+len);
        if(globalThis.crypto&&globalThis.crypto.getRandomValues){ for(let o=0;o<len;o+=65536) globalThis.crypto.getRandomValues(a.subarray(o,Math.min(o+65536,len))); }
        else { for(let i=0;i<len;i++)a[i]=(Math.random()*256)|0; }
        return 0; },
      fd_close:(fd)=>{ const f=w.fds.get(fd); w.fds.delete(fd); if(f&&f.type==='pipe') w.gcPipe(f.pipe);
        if(f&&f.type==='sock'&&w.net) { try { w.net.close(f.sock); } catch { /* already gone */ } }
        return 0; },
      // The rights word is where isatty() lives. wasi-libc answers isatty(fd)
      // with "filetype is CHARACTER_DEVICE **and** neither FD_SEEK nor FD_TELL
      // is granted" — a terminal is the thing you cannot seek — so claiming
      // every right on stdio is what has been reporting "not a tty" all along.
      // Dropping the two bits on a tty fd is the entire change; see the fd
      // table for what it unlocks and why it is opt-in.
      fd_fdstat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const ft=f.type==='dir'?FT.DIR:(f.type==='file'?FT.REG:FT.CHAR); const rights=f.tty?(~0n&~RIGHTS_NOT_A_TTY):~0n; w.dv().setUint8(out,ft); w.dv().setUint16(out+2,0,true); w.dv().setBigUint64(out+8,rights,true); w.dv().setBigUint64(out+16,rights,true); return 0; },
      fd_fdstat_set_flags:(fd,flags)=>{ const f=w.fds.get(fd); if(f) f.nonblock=(flags&4)!==0; return 0; },
      fd_prestat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f||!f.preopen) return E.BADF; w.dv().setUint8(out,0); w.dv().setUint32(out+4,strBytes(f.path).length,true); return 0; },
      fd_prestat_dir_name:(fd,buf,len)=>{ const f=w.fds.get(fd); if(!f||!f.preopen) return E.BADF; w.bytes().set(strBytes(f.path).subarray(0,len),buf); return 0; },
      fd_filestat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF;
        // `gone` first, exactly as readFd checks it: once a name is unlinked a
        // NEW file can take it, and this fd must keep describing the one it
        // actually still reads. stdio and pipes have no path to stat at all.
        const st=(!f.gone&&f.path!==undefined&&w.statAt(f.path))||w.anonStat(f);
        w.writeFilestat(out,st); return 0; },
      path_filestat_get:(fd,flags,pathp,plen,out)=>{ const { st, errno }=w.statOf(w.resolve(fd,w.str(pathp,plen))); if(!st) return errno; w.writeFilestat(out,st); return 0; },
      path_open:(fd,dflags,pathp,plen,oflags,rb,ri,fdflags,out)=>{
        // oflags: 1=CREAT 2=DIRECTORY 4=EXCL 8=TRUNC; fdflags: 1=APPEND
        const path=w.resolve(fd,w.str(pathp,plen));
        let { st, errno }=w.statOf(path);
        if(!st){
          if(!(oflags&1)) return errno;
          // Creating a name under /dev would land in the store, where the
          // overlay then hides it forever.
          if(w.ownsPath(path)) return E.PERM;
          try { st=w.store.createFileSync(path,NEW_FILE); } catch(e) { return wasiErrno(e); }
        } else if((oflags&1)&&(oflags&4)) return E.EXIST;
        const device=w.devices.get(path);
        // A device may refuse the open outright — the host port does, with
        // EPERM, when the embedder handed over no capability object.
        if(device&&device.open){ const e=device.open(); if(e) return e; }
        if(!device&&!isDir(st.mode)&&(oflags&8)){
          try { w.store.touchSync(path,{size:0}); } catch(e) { return wasiErrno(e); }
        }
        const nfd=w.nextFd++;
        if(isDir(st.mode)) w.fds.set(nfd,{type:'dir',path});
        // pos is a SHARED CELL, not a number: dup/dup2 copy the record with
        // {...src}, and POSIX says duped fds share one file offset (see pos()).
        else w.fds.set(nfd,{type:'file',path,device,pos:{v:0},append:(fdflags&1)!==0});
        w.dv().setUint32(out,nfd,true); return 0;
      },
      // fd_read/fd_write are the iovec scatter/gather around readFd/writeFd —
      // the per-fd-type routing lives there so host builtins can reach it too
      // (see the __host_builtin_run hook and the readFd/writeFd comments).
      fd_read:(fd,iovs,n,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF;
        const bufs=w.iovecs(iovs,n);
        const { data, errno } = w.readFd(fd, bufs.reduce((a,b)=>a+b.length,0), f.nonblock);
        let o=0; for(const b of bufs){ const take=Math.min(b.length,data.length-o); b.set(data.subarray(o,o+take)); o+=take; if(o>=data.length)break; }
        w.dv().setUint32(out,o,true); return errno; },
      // A failing writeFd used to be impossible past the BADF check, so its
      // return value was dropped. A store can genuinely refuse — read-only,
      // out of space, a revoked directory handle — and reporting those bytes
      // as written is silent data loss. Stop at the failure and report the
      // count that did land, exactly as a short write(2) does.
      fd_write:(fd,iovs,n,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const bufs=w.iovecs(iovs,n);
        // A DEVICE sees one write, never a gather. The short-write protocol
        // below asks the caller to send the rest again, and a device has
        // already ACTED on what it took — so a scatter whose later buffer
        // failed would come back and run a verb the port had already run. A
        // character device's write(2) is one call with one result; make it so
        // by joining first. (Single-buffer writes, i.e. nearly all of them,
        // pass straight through.)
        if(f.device){
          const b=bufs.length===1?bufs[0]:joinBytes(bufs);
          // write(2) with nothing to write is a no-op, and the device must not
          // hear about it: for the host port it would end an exchange that a
          // real write is still in the middle of.
          if(!b.length){ w.dv().setUint32(out,0,true); return 0; }
          const errno=w.writeFd(fd,b);
          w.dv().setUint32(out,errno?0:b.length,true);
          return errno;
        }
        let total=0;
        for(const b of bufs){
          const errno=w.writeFd(fd,b);
          if(!errno){ total+=b.length; continue; }
          // Bytes already written stay written. WASI has one result, so an
          // errno here means the whole call failed and wasi-libc returns -1 —
          // a retry would then write those bytes twice. Once anything has
          // landed this is a SHORT WRITE: success, with the partial count.
          w.dv().setUint32(out,total,true);
          return total?0:errno;
        }
        w.dv().setUint32(out,total,true); return 0; },
      // An unseekable fd is ESPIPE, as lseek says. A pipe keeps its offset on
      // the pipe object and the stdin ring has none, so moving their cell was
      // invisible — but SUCCESS is not: lseek() is how a program asks whether
      // an fd can seek, and stdio calls it when it gives back a buffered read
      // (the applet drain in build/ash-forkfree.patch). A file redirected onto
      // fd 0 is a file, not the ring — dup2 copies the record — so `head -1 <
      // f` still seeks.
      // A negative result is EINVAL and leaves the offset alone, as lseek does.
      // Without the check a rewind past the start makes every later read ask
      // the store for a range it will zero-fill, and the guest gets fabricated
      // NUL bytes reported as a successful read.
      fd_seek:(fd,off,whence,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; if(f.type==='pipe'||f.type==='stdin'||f.type==='stdout'||f.type==='stderr') return E.SPIPE; const p=w.pos(f); const sz=w.sizeOf(f); off=Number(off);
        const next=whence===0?off:whence===1?p.v+off:sz+off;
        if(!Number.isFinite(next)||next<0) return E.INVAL;
        p.v=next; w.dv().setBigUint64(out,BigInt(p.v),true); return 0; },
      // A SHORT answer means "the directory ended", so a buffer that cannot
      // hold the next entry must be filled to its last byte rather than left
      // short of it. wasi-libc reads `used < len` as end-of-directory and
      // stops asking — it does not re-read with the cookie — so breaking on
      // the first entry that does not fit silently truncates every directory
      // bigger than one buffer. Measured on Laravel's vendor tree: 824 entries
      // in carbon/src/Carbon/Lang, 125 of them visible to `find`.
      //
      // So the last entry is written PARTIALLY, header and name both cut at
      // the end of the buffer, and `used == len` is what tells the caller to
      // come back with the cookie of the last entry it managed to parse whole.
      fd_readdir:(fd,buf,len,cookie,out)=>{ const f=w.fds.get(fd); if(!f||f.type!=='dir') return E.BADF;
        let ents; try { ents=w.readdirAt(f.path); } catch(e) { return wasiErrno(e); }
        const end=buf+len; let p=buf; let idx=Number(cookie);
        // One scratch dirent, refilled per entry: bytes 21-23 are the padding
        // after d_type and stay zero for the life of the buffer.
        const dirent=new DataView(new ArrayBuffer(24)); const db=new Uint8Array(dirent.buffer);
        for(;idx<ents.length&&p<end;idx++){ const name=ents[idx]; const nb=strBytes(name); const child=w.statAt(joinPath(f.path,name));
          dirent.setBigUint64(0,BigInt(idx+1),true); dirent.setBigUint64(8,BigInt(child?child.ino:0),true); dirent.setUint32(16,nb.length,true); dirent.setUint8(20,child&&isDir(child.mode)?FT.DIR:FT.REG);
          const hn=Math.min(24,end-p); w.bytes().set(db.subarray(0,hn),p); p+=hn;
          if(p<end){ const nn=Math.min(nb.length,end-p); w.bytes().set(nb.subarray(0,nn),p); p+=nn; } }
        w.dv().setUint32(out,p-buf,true); return 0; },
      // ---- writable-FS ops (rm/mkdir/rmdir/mv and friends) ----
      path_unlink_file:(fd,pathp,plen)=>w.removeNode(w.resolve(fd,w.str(pathp,plen)),false),
      path_remove_directory:(fd,pathp,plen)=>w.removeNode(w.resolve(fd,w.str(pathp,plen)),true),
      path_create_directory:(fd,pathp,plen)=>w.makeDir(w.resolve(fd,w.str(pathp,plen))),
      path_rename:(fd,pathp,plen,nfd,npathp,nplen)=>{
        const from=w.resolve(fd,w.str(pathp,plen)), to=w.resolve(nfd,w.str(npathp,nplen));
        const { st, errno }=w.statOf(from); if(!st) return errno;
        // Both ends: renaming ONTO a device name would write into the store at
        // a path the overlay permanently hides — `mv work.txt /dev/null` would
        // look like it worked and lose the file.
        if(st.device||w.ownsPath(from)||w.ownsPath(to)) return E.PERM;
        const tp=w.statOf(parentOf(to));
        if(!tp.st) return tp.errno ?? E.NOENT;
        if(!isDir(tp.st.mode)) return E.NOTDIR;
        if(from===to) return 0;
        // Renaming ONTO a name unlinks whatever was there, so fds open on the
        // destination need the same snapshot an unlink would give them —
        // otherwise they silently start reading the source file instead.
        const replaced=w.statAt(to);
        let cell=null;
        try {
          if(replaced&&!isDir(replaced.mode)) cell=w.snapshotOpenFds(to,replaced);
          w.store.renameSync(from,to);
        } catch(e) { return wasiErrno(e); }
        w.adoptSnapshot(to,cell);
        w.retargetOpenFds(from,to);          // an open fd follows the file
        return 0;
      },
      // touch lands here, and now it means something: mtime is a field of the
      // store, so `touch f` moves it instead of quietly doing nothing.
      // fstflags: 1=ATIM 2=ATIM_NOW 4=MTIM 8=MTIM_NOW; times are nanoseconds.
      path_filestat_set_times:(fd,flags,pathp,plen,atim,mtim,fstflags=0)=>{
        const path=w.resolve(fd,w.str(pathp,plen));
        const { st, errno }=w.statOf(path); if(!st) return errno ?? E.NOENT;
        if(st.device) return 0;
        const now=Date.now(), meta={};
        if(fstflags&1) meta.atimeMs=Number(atim)/1e6;
        if(fstflags&2) meta.atimeMs=now;
        if(fstflags&4) meta.mtimeMs=Number(mtim)/1e6;
        if(fstflags&8) meta.mtimeMs=now;
        try { w.store.touchSync(path,meta); } catch(e) { return wasiErrno(e); }
        return 0;
      },
      // No symlinks exist in this FS: readlink's EINVAL means "not a symlink".
      path_readlink:()=>E.INVAL,
      path_symlink:()=>E.NOSYS,
      path_link:()=>E.NOSYS,
      poll_oneoff:(subs,events,nsubs,out)=>{
        // Parse subscriptions: a clock (timeout) and/or fd_read events. Events
        // must ECHO the subscription's userdata (WASI matches by it).
        let timeoutMs=null, clockUD=null, stdinUD=null, otherRead=null, devUD=null, devPoll=null, sockUD=null, sockOf=null;
        for(let i=0;i<nsubs;i++){ const s=subs+i*48; const ud=w.dv().getBigUint64(s,true); const tag=w.dv().getUint8(s+8);
          if(tag===0){ const t=w.dv().getBigUint64(s+24,true); timeoutMs=Number(t)/1e6; clockUD=ud; }
          else if(tag===1){ const fd=w.dv().getUint32(s+16,true);
            // Route by the fd's TABLE TYPE, not its number. Only a real
            // ring-backed stdin consults w.input; a fd 0 that was dup2'd onto a
            // pipe/file (a redirection or `cmd | while read`) is an ordinary
            // readable fd. Keying on `fd===0` made poll wait on the empty ring
            // while the data sat in the pipe now on fd 0, so `read -t` timed out
            // instead of reading — and tuish's sub-second timer probe
            // (`echo 1 | read -t 0.01`) mis-detected, forcing a 1s escape
            // timeout in the browser. Matches fd_read, which keys on type too.
            const f=w.fds.get(fd);
            if(f && f.type==='stdin') stdinUD=ud;
            // A device that offers poll() is ASKED, never assumed. Assuming is
            // precisely how a queued resize went undelivered for as long as you
            // cared to wait: poll answered "readable" at once, so the wait
            // happened in the read that followed, where nothing wakes it. A
            // device whose read can block is that same trap with a new door.
            else if(f && f.device && f.device.poll){ devUD=ud; devPoll=f.device; }
            // A socket is ASKED too, for the device's reason one comment up: a
            // connection with nothing on it yet is not readable, and saying it
            // is turns the wait into a read that spins.
            else if(f && f.type==='sock'){ sockUD=ud; sockOf=f; }
            else otherRead=ud; } }
        let nev=0;
        const emitRead=(ud)=>{ const ev=events+nev*32; w.dv().setBigUint64(ev,ud,true); w.dv().setUint16(ev+8,0,true); w.dv().setUint8(ev+10,1); w.dv().setBigUint64(ev+16,64n,true); w.dv().setUint16(ev+24,0,true); nev++; };
        const emitClock=(ud)=>{ const ev=events+nev*32; w.dv().setBigUint64(ev,ud,true); w.dv().setUint16(ev+8,0,true); w.dv().setUint8(ev+10,0); nev++; };
        // Non-stdin read subs (pipes/files) are regular fds -> always readable.
        if(otherRead!==null) emitRead(otherRead);
        if(sockOf){
          let st;
          try { st=w.net.poll(sockOf.sock); } catch { st={readable:true}; }
          // A hangup is readable: the read that follows answers EOF, which is
          // how a caller learns the connection ended rather than waiting on it.
          if(st.readable||st.hup) emitRead(sockUD);
          else if(timeoutMs!=null) emitClock(clockUD);
          else emitRead(sockUD);
        }
        if(devPoll){
          // Two parkable subscriptions in one poll would each want the whole
          // wait, and nothing here ever asks for both — busybox's `read` polls
          // one fd. So the device only parks when it is alone; beside stdin it
          // is asked without waiting and stdin owns the park.
          const devWaitMs=(nev>0||stdinUD!==null)?0:timeoutMs;
          // Parks exactly as the stdin branch below does — /dev/hostreq's poll
          // is a ring's pollReadable, i.e. Atomics.wait — so it owes the same
          // "I am about to stop writing".
          if(devWaitMs!==0 && w.beforeBlock) w.beforeBlock();
          const ready=devPoll.poll(devWaitMs);
          if(ready) emitRead(devUD);
          else if(timeoutMs!=null) emitClock(clockUD);
          // Untimed, asked to park, and back with nothing: the device declined
          // to wait. Report readable rather than no events at all — a poll that
          // returns zero of both is a busy-spin, and the read behind it can
          // still answer EOF or EAGAIN for itself.
          else emitRead(devUD);
        }
        if(stdinUD!==null){
          // A closed stdin is READABLE (POSIX: EOF wakes poll) — the caller
          // then reads and gets EOF instead of timing out forever.
          const closed = () => w.input && w.input.closed && w.input.closed();
          // An UNTIMED poll has to park HERE, not in the read that follows it.
          // busybox says why, right above both of its callers: "We must poll
          // even if timeout is -1: we want to be interrupted if signal arrives"
          // (libbb/read_key.c, shell/shell_common.c). Reporting readable and
          // letting the guest block in read() instead put the wait somewhere no
          // signal reaches — so a resize posted while the shell sat idle at its
          // prompt was not delivered until the user typed something.
          // Only an input that can be woken by a non-byte event (winchPending)
          // can park indefinitely; for anything else null would never return.
          const canPark = !!(w.input && w.input.winchPending);
          // Zero when another subscription is already ready, when an input
          // that cannot park was going to be asked to, and when the suspending
          // wrapper has ALREADY done this wait on its own — waiting it twice is
          // what turns `read -t 1.2` into 2.4 seconds, which is half of what
          // the regression test above this file's `read -t` cases is for.
          const waitMs = (w.pollAlreadyWaited || nev>0 || (timeoutMs==null && !canPark)) ? 0 : timeoutMs;
          // pollReadable(ms) does the timed wait; when it comes back empty the
          // timeout has fully elapsed — report the clock, do NOT wait again.
          if(waitMs !== 0 && w.beforeBlock) w.beforeBlock();
          const ready = w.input && (w.input.pollReadable(waitMs) || closed());
          if(ready) emitRead(stdinUD);
          else if(timeoutMs!=null) emitClock(clockUD);
          // Untimed and woken with nothing to read: a queued resize ended the
          // wait. EINTR is what a real signal does to poll, and it is what the
          // guest's __wrap_poll needs in order to run winch_dispatch and then
          // decide whether a handler wanted it (see build/shim/wasistubs.c).
          else if(nev===0 && canPark && w.input.winchPending()){ w.dv().setUint32(out,0,true); return E.INTR; }
          else emitRead(stdinUD); // no reason to wait: let the caller read (may EOF)
        // A bare timeout, with nothing readable subscribed at all — sleep it
        // out. A device sub counts as something: it has already done this
        // poll's waiting and reported for itself, and sleeping the timeout a
        // second time here would double it.
        } else if(otherRead===null && devPoll===null && timeoutMs!=null){ if(w.beforeBlock) w.beforeBlock(); if(w.input && w.input.wait) w.input.wait(timeoutMs); emitClock(clockUD); }
        w.dv().setUint32(out,nev,true); return 0; },
    };
    // ---- host builtins: everything the two shapes of the run import share ----
    //
    // There are two because a handler may now be allowed to AWAIT — see the
    // `suspendable` option — and the difference between them is exactly one
    // keyword. Everything up to the handler call is identical and has to be:
    // argv, env and cwd are read out of linear memory HERE, before any
    // suspension, because a suspended guest's memory is still live and a
    // pointer read after the fact would be read against whatever the shell did
    // next.
    const builtinCtx=(cwdPtr,argc,argvPtr,envpPtr)=>{
      const argv=w.cstrv(argvPtr,argc>0?argc:4096);
      const cwd=w.cstr(cwdPtr)||'/';
      // The interrupt baseline, read BEFORE the handler runs. A ^C posted
      // while the shell sat at its prompt, or during the applet before this
      // one, is already in the count — so comparing against it means
      // "interrupted since this command started" and this command does not
      // inherit somebody else's cancel. An input with no interrupt channel
      // (run(), a fixed stdin) leaves interrupted() permanently false.
      const intr0=(w.input&&w.input.interruptCount)?w.input.interruptCount():null;
      // The OTHER half of raise() gets the same fresh start, and needs it more.
      // The count above is baselined; the signal cell is a byte somebody else
      // reads, and nothing clears it until a guest that polls memory happens to
      // run. So a ^C at an idle prompt SAT there — and the next Python command,
      // or the next request the frame made, died of a KeyboardInterrupt nobody
      // aimed at it. Zeroed here, where the count is baselined, because this is
      // the same moment: whatever was raised before this command started was
      // not raised at this command. A ^C during it still writes the byte.
      if(w.input&&w.input.signalBuffer) w.input.signalBuffer()[0]=0;
      return {
        argv, cwd,
        // The guest's LIVE environ (exports plus this command's VAR=x
        // prefixes), not the spawn-time env — this.env is frozen at
        // construction, which is exactly why the hook passes envp at all.
        env:envpPtr?envObj(w.cstrv(envpPtr)):envObj(w.env),
        // Blocking, regardless of any O_NONBLOCK `read -t` left on fd 0.
        // Empty means EOF. The slice matters: readFd may hand back a view
        // into a caller-mounted buffer.
        stdin:(max=65536)=>w.readFd(0,max,false).data.slice(),
        // writeFd answers an errno and this used to drop it, so a write
        // a device REFUSED looked delivered — a builtin replying through
        // /dev/host on a session with no port returned success with
        // nothing sent. It throws now, which the containment below turns
        // into a failed command and a non-zero $?: the two things a script
        // can act on. Nothing else here can fail — a pipe with no reader
        // buffers rather than EPIPE, fork-free.
        stdout:(b)=>{ const e=w.writeFd(1,bytesOf(b)); if(e) throw new Error(`write to stdout failed: ${errnoName(e)}`); },
        stderr:(b)=>{ const e=w.writeFd(2,bytesOf(b)); if(e) throw new Error(`write to stderr failed: ${errnoName(e)}`); },
        fs:w.hostFs(cwd),
        // Has a ^C landed since this command started? Cooperative and
        // POLLED: the handler runs on the guest's own stack, so nothing
        // can unwind it from outside and there is no safe point but the
        // ones the handler itself chooses. A long loop checks it and
        // returns 130 (128+SIGINT), which is what a shell script reads as
        // "interrupted" in `$?`.
        //
        // It does NOT end a blocking ctx.stdin(): that read parks in
        // Atomics.wait and an interrupt wakes the wait but does not make
        // bytes appear, so the read parks again. A builtin that wants to
        // be interruptible while waiting for input must read with its own
        // timeout and check between attempts.
        //
        // A SUSPENDED handler cannot poll it either — there is no stack
        // running to do the polling — so work that awaits is work a ^C
        // cannot reach until it comes back.
        interrupted:()=> intr0!==null && w.input.interruptCount()!==intr0,
      };
    };
    // A JS exception thrown out of a wasm import unwinds the ENTIRE guest
    // stack: the instance is dead and no guest setjmp can catch it. That is
    // the same hazard --wrap exit/die_func exists for with applets, and it
    // must be contained the same way — a handler bug costs one command, not
    // the shell. A nested WasiExit is caught HERE too: letting it escape
    // would make an inner module's exit(1) silently become the outer shell's
    // exit code (worker.mjs treats a WasiExit as a clean shutdown).
    const builtinThrew=(name,e)=>{
      if(e instanceof WasiExit) return e.code&0xff;
      w.writeFd(2,strBytes(`${name}: ${(e&&e.message)||e}\n`));
      return 1;
    };
    const builtinStatus=(status)=>{
      const n=Number(status);
      return Number.isFinite(n)?(n&0xff):0;   // wait(2) truncation: -1 -> 255, 256 -> 0
    };
    // The synchronous shape, and the one every session had until suspension
    // was an option. A promise here is not slow, it is NOT DELIVERED — the
    // guest is a synchronous stack frame below us and a thenable coerces to
    // i32 0, i.e. silent success while the real work lands later against
    // whatever fd 1 has become by then. Fail loudly instead.
    const builtinRunSync=(cwdPtr,argc,argvPtr,envpPtr)=>{
      if(!w.builtins) return -1;
      const ctx=builtinCtx(cwdPtr,argc,argvPtr,envpPtr);
      let status;
      // Synchronous, so nothing is waiting — but a handler may still post to
      // the page, and held output must not arrive after what it says.
      if(w.beforeBlock) w.beforeBlock();
      try { status=w.builtins.run(ctx); }
      catch(e){ return builtinThrew(ctx.argv[0]||'',e); }
      if(status&&typeof status.then==='function'){
        status.catch(()=>{});   // nobody owns this rejection
        w.writeFd(2,strBytes(`${ctx.argv[0]||''}: handler returned a Promise; host builtins must be synchronous here. Do async setup once in serve({ async builtins() {...} }), or pass suspendable:true to let a handler await mid-session (needs WebAssembly.Suspending)\n`));
        return 1;
      }
      return builtinStatus(status);
    };
    // The suspending shape. `await` on a value that is not a promise is a
    // microtask and nothing more, so a synchronous handler costs the same
    // here as it does above — measured at 6.3 µs per call either way, which
    // is why there is one import rather than a fast one and a slow one.
    const builtinRunSuspending=async(cwdPtr,argc,argvPtr,envpPtr)=>{
      if(!w.builtins) return -1;
      const ctx=builtinCtx(cwdPtr,argc,argvPtr,envpPtr);
      let status;
      // A handler that awaits yields the thread exactly as a park does, and for
      // an unbounded time — `wide load python` fetches an interpreter. Anything
      // written before it (its own progress line, most of all) has to be on the
      // screen while it runs, not batched until the shell next waits for a key.
      if(w.beforeBlock) w.beforeBlock();
      try { status=await w.builtins.run(ctx); }
      catch(e){ return builtinThrew(ctx.argv[0]||'',e); }
      return builtinStatus(status);
    };
    // Swap the two waiting imports for suspending twins.
    //
    // The only difference is WHO waits. Sync, a guest with nothing to read
    // parks the worker thread in Atomics.wait and the event loop under it stops
    // — which is why a shell that owns its own prompt cannot coexist with a
    // host builtin the page wants to call. Suspended, the guest's stack is put
    // aside and the thread goes back to its queue until bytes arrive.
    //
    // Memory views are re-fetched AFTER the await (dv()/bytes() do that on
    // every call): a suspension is an arbitrary amount of other people's code,
    // and wasm memory can grow underneath it.
    if (w.suspendInput || w.suspendNet) {
      // Captured BEFORE the swap: everything that is not a parked read still
      // goes through the synchronous one, and reaching for `p1.fd_read` after
      // the assignment below would be the wrapper calling itself.
      const readSync = p1.fd_read;
      /**
       * Scatter what the await produced into the guest's buffers.
       *
       * The iovecs are re-read here rather than reused from before the await.
       * A suspension is an arbitrary amount of other people's code and wasm
       * memory can grow underneath it, which detaches every view taken earlier
       * — writing through one of those writes into a buffer nobody owns.
       */
      const scatter = (iovs, n, out, data) => {
        const bufs = w.iovecs(iovs, n);
        let o = 0;
        for (const b of bufs) { const take = Math.min(b.length, data.length - o); b.set(data.subarray(o, o + take)); o += take; if (o >= data.length) break; }
        w.dv().setUint32(out, o, true);
        return o;
      };
      const readSuspending = async (fd, iovs, n, out) => {
        const f = w.fds.get(fd); if (!f) return E.BADF;
        // A socket read is the longer wait of the two and the one that used to
        // hold the thread outright: `recv` answers from a connection table
        // whose backend parks, so a download owned this worker for its whole
        // length. Awaited, the thread goes back to its queue between chunks and
        // everything else it serves keeps being served.
        //
        // Non-blocking is still non-blocking: an fd that asked not to wait gets
        // the synchronous answer, EAGAIN and all.
        if (f.type === 'sock' && w.suspendNet && !f.nonblock) {
          if (f.sock === null) return readSync(fd, iovs, n, out);
          const max = w.iovecs(iovs, n).reduce((a, b) => a + b.length, 0);
          // Unconditionally, unlike the stdin path below, which can see for
          // itself whether it is about to wait. Here it cannot be known without
          // asking the net — and asking through the SYNCHRONOUS read would send
          // the request down the parked door, which is the thing being avoided.
          //
          // It costs nothing worth having. A download to a file writes no
          // stdout, so there is nothing to flush; a `wget -O -` writes some
          // between reads, and flushing it per chunk is progressive output
          // rather than a batch at the end.
          if(w.beforeBlock) w.beforeBlock();
          let data;
          try { data = await w.net.recvAsync(f.sock, max); }
          catch (e) { return wasiErrno(e); }
          // `null` is the net's "nothing yet" and it survives the await: the
          // guest has not finished writing its request, which no amount of
          // waiting on this end will change.
          if (data === null) { w.dv().setUint32(out, 0, true); return E.AGAIN; }
          scatter(iovs, n, out, data);
          return 0;
        }
        if (f.type !== 'stdin' || f.nonblock || !w.suspendInput) return readSync(fd, iovs, n, out);
        const bufs = w.iovecs(iovs, n);
        const max = bufs.reduce((a, b) => a + b.length, 0);
        let data = w.input ? w.input.read(max) : EMPTY;
        if (data.length === 0 && !(w.input && w.input.closed && w.input.closed())) {
          if(w.beforeBlock) w.beforeBlock();
        data = await w.input.readBlockingAsync(max);
        }
        scatter(iovs, n, out, data);
        return data.length === 0 ? ((w.input && w.input.closed && w.input.closed()) ? 0 : E.AGAIN) : 0;
      };
      p1.fd_read = new WebAssembly.Suspending(readSuspending);

      // And the one that actually matters at a prompt. busybox polls before it
      // reads — "we must poll even if timeout is -1: we want to be interrupted
      // if signal arrives" — so an idle shell is parked HERE, not in fd_read.
      //
      // The wait is lifted OUT rather than the function rewritten: find the
      // stdin subscription, await it here, then hand the whole thing to the
      // synchronous implementation, which now finds the data ready and parks on
      // nothing. One await, no second copy of the WASI event encoding.
      const pollSync = p1.poll_oneoff;
      // Stdin only, deliberately. A socket subscription needs no wait lifted
      // out of here: poll() reports a queued request as readable — the bytes
      // are not here, but asking for them is this side's work — so the guest
      // goes straight to the read, and the read is where the await belongs.
      const pollSuspending = async (subs, events, nsubs, out) => {
        let timeoutMs = null, wantsStdin = false, others = false;
        for (let i = 0; i < nsubs; i++) {
          const s = subs + i * 48;
          const tag = w.dv().getUint8(s + 8);
          if (tag === 0) timeoutMs = Number(w.dv().getBigUint64(s + 24, true)) / 1e6;
          else if (tag === 1) {
            const f = w.fds.get(w.dv().getUint32(s + 16, true));
            if (f && f.type === 'stdin') wantsStdin = true; else others = true;
          }
        }
        const input = w.input;
        if (wantsStdin && !others && input && input.pollReadableAsync
          && !(input.closed && input.closed())
          && !(input.pollReadable && input.pollReadable(0))) {
          if(w.beforeBlock) w.beforeBlock();
          await input.pollReadableAsync(timeoutMs);
          // The wait is spent. Everything below — which event to emit, whether
          // a pending winch means EINTR — is still the sync implementation's
          // to decide, but it must decide it without parking again.
          w.pollAlreadyWaited = true;
          try { return pollSync(subs, events, nsubs, out); }
          finally { w.pollAlreadyWaited = false; }
        }
        return pollSync(subs, events, nsubs, out);
      };
      if (w.suspendInput) p1.poll_oneoff = new WebAssembly.Suspending(pollSuspending);
    }
    return {
      wasi_snapshot_preview1: p1,
      env: {
        __host_pipe:(fdptr)=>{ const idx=w.pipes.length; w.pipes.push({chunks:[],off:0}); const r=w.nextFd++, wr=w.nextFd++; w.fds.set(r,{type:'pipe',pipe:idx}); w.fds.set(wr,{type:'pipe',pipe:idx}); w.dv().setUint32(fdptr,r,true); w.dv().setUint32(fdptr+4,wr,true); return 0; },
        // F_DUPFD: lowest free fd >= minfd, sharing the source's backing.
        // Sockets. preview1 can neither make one nor dial with it, so these
        // three are the whole of what busybox could not do for itself; the
        // reading and writing is fd_read/fd_write, because that is what it
        // uses on the descriptor once it has one.
        __host_sock_open:()=>{
          if(!w.net) return -1;
          const fd=w.nextFd++;
          w.fds.set(fd,{type:'sock',sock:null});
          return fd;
        },
        // The address arrives in NETWORK byte order, exactly as struct in_addr
        // held it, and is turned back into dotted quad here — the form the net
        // handed out in the first place.
        __host_sock_connect:(fd,addr,port)=>{
          const f=w.fds.get(fd);
          if(!f||f.type!=='sock'||!w.net) return -1;
          const a=addr>>>0;
          const dotted=`${a&0xff}.${(a>>>8)&0xff}.${(a>>>16)&0xff}.${(a>>>24)&0xff}`;
          try { f.sock=w.net.connect(dotted,port); } catch { return -1; }
          return 0;
        },
        __host_sock_resolve:(namePtr,outPtr)=>{
          if(!w.net) return -1;
          let name=''; const b=w.bytes();
          for(let i=namePtr;b[i];i++) name+=String.fromCharCode(b[i]);
          let dotted;
          try { dotted=w.net.resolve(name); } catch { return -1; }
          if(!dotted) return -1;
          const parts=dotted.split('.').map(Number);
          if(parts.length!==4||parts.some((n)=>!Number.isInteger(n)||n<0||n>255)) return -1;
          // Network order: the first octet is the lowest address, which is what
          // a little-endian setUint32 of the reversed word produces.
          w.dv().setUint32(outPtr,(parts[3]<<24)|(parts[2]<<16)|(parts[1]<<8)|parts[0],true);
          return 0;
        },
        __host_dup:(fd,minfd)=>{ const src=w.fds.get(fd); if(!src) return -1; let n=Math.max(minfd,4); while(w.fds.has(n)) n++; if(n>=w.nextFd) w.nextFd=n+1; w.fds.set(n,{...src,preopen:false}); return n; },
        __host_dup2:(oldfd,newfd)=>{ const src=w.fds.get(oldfd); if(!src) return -1; const prev=w.fds.get(newfd); if(newfd>=w.nextFd) w.nextFd=newfd+1; w.fds.set(newfd,{...src,preopen:false}); if(prev&&prev.type==='pipe') w.gcPipe(prev.pipe); return newfd; },
        __host_trace:()=>{},   // debug hook (present in traced builds; harmless)
        // Terminal geometry for a RUNNING guest. env is frozen at spawn and
        // there are no signals, so size and resize travel through the stdin
        // ring's winsize slots (see ring.mjs) and surface here:
        //   __host_winsize -> ioctl(TIOCGWINSZ) reads the live rows/cols
        //   __host_winch   -> the guest's poll point turns a pending resize
        //                     into a synthesized SIGWINCH (fires `trap WINCH`)
        // Both degrade to "no info" when input has no winsize (run() mode).
        __host_winsize:(rowsPtr,colsPtr)=>{ const ws=(w.input&&w.input.winsize)?w.input.winsize():{rows:0,cols:0}; w.dv().setUint32(rowsPtr,ws.rows>>>0,true); w.dv().setUint32(colsPtr,ws.cols>>>0,true); },
        __host_winch:()=> (w.input&&w.input.takeWinch&&w.input.takeWinch())?1:0,
        // The cooperative interrupt, read by the GUEST rather than raised at
        // it: a monotonic count the applet in flight compares against the value
        // it started at (build/shim/wasistubs.c, build/applet-interrupt.patch).
        // Nothing is consumed here, so an interrupt posted while no applet is
        // running has nobody to cancel and cancels nobody. Degrades to a
        // constant 0 without an interrupt channel — run(), a fixed stdin — which
        // is the same "no info" contract the two hooks above have.
        __host_interrupt:()=> (w.input&&w.input.interruptCount)?w.input.interruptCount():0,
        // ---- host builtins: the shell's command namespace, extended in JS ----
        // ash resolves a name against functions, builtins, then the applet
        // table; these two hooks sit where the PATH search (which can never
        // succeed here — the FS has no permission bits) used to lead to "not
        // found". See build/ash-hostbuiltin.patch and build/shim/wasistubs.c.
        //   lookup -> a PREDICATE: find_command, `type` and `command -v` all
        //             need an answer WITHOUT running anything
        //   run    -> execute; the return value becomes $?
        // Absent `builtins`, both answer "no such command" and the shell is
        // byte-for-byte what it was — the same "degrade to no info" contract
        // __host_winsize follows above.
        __host_builtin_lookup:(namePtr,len)=>{
          if(!w.builtins) return 0;
          // A throwing lookup() must not cost the session a `type foo`.
          try { return w.builtins.lookup(len>0?w.str(namePtr,len):w.cstr(namePtr))?1:0; } catch { return 0; }
        },
        // Enumeration, for tab completion (build/ash-complete-hostbuiltin.patch): write the
        // i'th registered name into the guest's buffer and return its length,
        // 0 once the list is out. `names()` is the contract's OPTIONAL third
        // method, so a provider that only knows how to look one name up
        // answers 0 at index 0 and completion simply learns nothing about it —
        // the same shape as a session with no builtins.
        //
        // The list is rebuilt when the walk RESTARTS and cached within it.
        // Both halves matter and they used to be one: this is called once per
        // candidate per completion, so a names() that answered differently
        // mid-walk would skip or repeat entries — but registration no longer
        // "happens once, before _start()", because a provider can gain and lose
        // names while the session runs (see builtinRegistry). Snapshotting for
        // the life of the shell would keep offering a command that has been
        // removed and never offer one that arrived.
        //
        // A name too long for the guest's buffer is dropped HERE rather than
        // reported, because one length cannot say both "skip" and "end" — see
        // host_builtin_name() in build/shim/wasistubs.c.
        __host_builtin_name:(i,buf,len)=>{
          if(!w.builtins||typeof w.builtins.names!=='function') return 0;
          if(i===0||!w.builtinNames){
            try { const l=w.builtins.names(); w.builtinNames=Array.isArray(l)?l.map(String):[]; }
            catch { w.builtinNames=[]; }
          }
          const names=w.builtinNames;
          for(let n=0,k=0;n<names.length;n++){
            const b=strBytes(names[n]);
            if(b.length===0||b.length>len) continue;
            if(k++!==i) continue;
            w.bytes().set(b,buf); return b.length;
          }
          return 0;
        },
        // The handler runs ON THE GUEST'S OWN STACK, mid-import. argv/env/cwd
        // are copied out of linear memory first; stdio goes through the fd
        // TABLE, so a pipeline stage, a redirect and a $(...) capture all land
        // where the shell put them.
        //
        // Wrapped in WebAssembly.Suspending when the session asked for it and
        // the engine has it, which is what lets a handler await without the
        // guest below it having to know: JSPI suspends the whole wasm stack,
        // ash's setjmp frames included. Verified across $(...), pipelines,
        // functions, redirects and `||` in node, Chromium and Firefox.
        __host_builtin_run: w.suspendable
          ? new WebAssembly.Suspending(builtinRunSuspending)
          : builtinRunSync,
      },
    };
  }
  // ---- helpers ----
  // stat across the device overlay and the store, keeping WHY it failed. A
  // store refuses for reasons that are not "missing" — EACCES, a directory
  // handle the user revoked — and collapsing those to ENOENT tells the guest a
  // comfortable lie it will act on. Every FS import starts here, so /dev never
  // reaches a store and a store's exception never escapes into the guest.
  statOf(path){
    const dev=this.deviceStat(path);
    if(dev) return { st:dev };
    if(this.ownsPath(path)) return { st:null, errno:E.NOENT };   // shadowed by the overlay
    try { return { st:this.store.statSync(path) }; }
    catch(e) { return { st:null, errno:wasiErrno(e) }; }
  }
  // The same, for the many callers that only need "is anything there".
  statAt(path){ return this.statOf(path).st; }
  // /dev belongs to the overlay whole, not entry by entry: a store with its
  // own /dev is shadowed entirely rather than half-visible, so nothing can be
  // written to a name that `ls /dev` will never show.
  ownsPath(path){ return ownsDevPath(path); }
  // Register a character device in the /dev overlay:
  //   read(max,owner,nonblock) -> bytes | errno    write(bytes,owner) -> errno | undefined
  //   open() -> errno | 0   (refuse the open; the port's EPERM)
  //   poll(ms) -> bool      (optional; true when a read would not block)
  // The inode is assigned HERE, which is the whole point — a device is one
  // entry in one map, so `ls /dev`, stat and open cannot describe different
  // sets of names.
  addDevice(path,dev){
    const p=normalize(path);
    // Directly under /dev, and flat. readdirAt('/dev') lists basenames, so
    // '/dev/bus/usb' would show up as `usb` and then stat as ENOENT at
    // /dev/usb — the exact list-versus-open divergence one registration point
    // exists to make impossible.
    if(parentOf(p)!=='/dev') throw new Error(`addDevice: '${p}' must be a name directly under /dev, the only namespace the overlay owns`);
    if(typeof dev.read!=='function'&&typeof dev.write!=='function') throw new Error(`addDevice: '${p}' implements neither read nor write`);
    // Bound calls, not a spread. {...dev} copies own enumerable properties
    // only, so a class instance would arrive with no methods at all and the
    // first read would throw out of a wasm import — which unwinds the entire
    // guest stack and kills the shell over a missing function. The defaults
    // say what a half-implemented device means: nothing to read, and nothing
    // that may be written.
    this.devices.set(p,{
      ino:this.nextDevIno++,
      read:typeof dev.read==='function'?(max,owner,nonblock)=>devRead(dev.read(max,owner,nonblock)):()=>({ data:EMPTY, errno:0 }),
      write:typeof dev.write==='function'?(b,owner)=>dev.write(b,owner):()=>E.PERM,
      open:typeof dev.open==='function'?()=>dev.open():null,
      // Optional, and its PRESENCE is the signal — exactly as input.winchPending's
      // is. A device with no poll() is readable the moment it is asked, which is
      // true of everything the overlay held until now; one that can make a read
      // WAIT has to be asked first, or the wait lands in the read that follows
      // and nothing there can end it. See poll_oneoff.
      poll:typeof dev.poll==='function'?(ms)=>!!dev.poll(ms):null,
    });
    return this;
  }
  deviceStat(path){
    if(path==='/dev') return this.devNode(DEV_DIR_INO,true);
    const dev=this.devices.get(path);
    return dev?this.devNode(dev.ino,false):null;
  }
  devNode(ino,dir){
    const t=this.bootMs;
    return { ino, nlink:1, size:0, mode:(dir?S_IFDIR|0o755:S_IFCHR|0o666), uid:0, gid:0,
      atimeMs:t, mtimeMs:t, ctimeMs:t, device:true };
  }
  // What an fd with no live path reports to fstat. An unlinked-but-open file
  // is still a REGULAR file with its size — reporting a character device would
  // fail every S_ISREG check in exactly the case the snapshot exists to save —
  // and nlink 0 is what a real one says.
  anonStat(f){
    const t=this.bootMs, gone=f&&f.gone;
    return { ino:0, nlink:gone?0:1, size:gone?gone.data.length:0,
      mode:gone?(S_IFREG|0o644):(f&&f.type==='dir'?S_IFDIR|0o755:S_IFCHR|0o666), uid:0, gid:0,
      atimeMs:t, mtimeMs:t, ctimeMs:t, device:!gone };
  }
  // Directory entries, with /dev grafted onto the root.
  readdirAt(path){
    if(path==='/dev') return [...this.devices.keys()].map((p)=>p.slice(p.lastIndexOf('/')+1));
    const names=this.store.readdirSync(path);      // may throw; fd_readdir translates
    if(path!=='/') return names;
    return names.includes('dev')?names:['dev',...names];
  }
  sizeOf(f){
    if(f.gone) return f.gone.data.length;
    if(f.path===undefined) return 0;
    const st=this.statAt(f.path);
    return st?st.size:0;
  }
  // POSIX keeps an unlinked file readable through every fd still open on it.
  // The store is path-addressed and forgets it the moment the name goes, so
  // the bytes move onto the fds that still care — in a SHARED CELL, for the
  // same reason `pos` is one: dup/dup2 copy the record with {...src}, and two
  // fds on one open description must not drift apart when a write grows it.
  //
  // The one divergence: with nlink > 1 the file still exists under its other
  // name, and writes through this fd will not reach it. The guest cannot make
  // a hard link (path_link is ENOSYS), so only an embedder's pre-linked store
  // can get here.
  //
  // Two phases, because the removal that motivates it can still fail: taking
  // the snapshot must not commit anything, or a store that refuses the unlink
  // leaves live fds writing into a phantom and reporting success.
  snapshotOpenFds(path,st){
    let wanted=false;
    for(const f of this.fds.values()) if(f.path===path&&f.type==='file'&&!f.gone) { wanted=true; break; }
    if(!wanted) return null;
    const bytes=new Uint8Array(st.size);
    if(st.size) this.store.readSync(path,bytes,0,st.size);
    return { data:bytes };
  }
  adoptSnapshot(path,cell){
    if(!cell) return;
    for(const f of this.fds.values()) if(f.path===path&&f.type==='file'&&!f.gone) f.gone=cell;
  }
  // A rename does not disturb an open fd: it follows the file, not the name.
  // Path-addressed fds have to be told, subtree and all.
  retargetOpenFds(from,to){
    const prefix=`${from}/`;
    for(const f of this.fds.values()){
      if(f.path===undefined) continue;
      if(f.path===from) f.path=to;
      else if(f.path.startsWith(prefix)) f.path=to+f.path.slice(from.length);
    }
  }
  // Read up to `max` bytes from one fd, routing on the fd TABLE TYPE — fd_read's
  // whole body minus the iovec scatter. Returns { data, errno }:
  //   errno 0, data non-empty -> bytes
  //   errno 0, data empty     -> true EOF
  //   errno E.AGAIN           -> nothing yet; the caller must retry
  // `nonblock` is passed in rather than read off the fd so a host builtin can
  // take the blocking path even while `read -t` has fd 0 flagged O_NONBLOCK.
  // `data` may be a view into an FS node or into whatever input.read() returned
  // — copy it before retaining (ctx.stdin does).
  // Read from an `input`-shaped source: stdin, or the inbound request channel,
  // which is the same contract aimed the other way. Returns { data, errno } as
  // readFd does.
  //
  // No data. A BLOCKING read must wait — else `while read` sees failure and the
  // loop ends one line early. A NON-blocking read gets EAGAIN so `read -t`
  // timeout logic runs. A CLOSED source reads 0 bytes with SUCCESS — true EOF,
  // which is what ends the loop.
  readInput(src,max,nonblock){
    let data=src?src.read(max):EMPTY;
    if(data.length===0){
      if(!nonblock && src && src.readBlocking){ if(this.beforeBlock) this.beforeBlock(); data=src.readBlocking(max); }
      if(data.length===0){
        return { data:EMPTY, errno:(src && src.closed && src.closed()) ? 0 : E.AGAIN };
      }
    }
    return { data, errno:0 };
  }
  readFd(fd,max,nonblock){
    const f=this.fds.get(fd);
    if(!f) return { data:EMPTY, errno:E.BADF };
    if(f.type==='stdin') return this.readInput(this.input,max,nonblock);
    // The offset cell identifies the OPEN DESCRIPTION — fresh per path_open,
    // shared across dup/dup2 exactly as POSIX shares an offset. A device that
    // holds per-exchange state (the host port does) needs to know which open
    // it is being spoken to through; one that does not can ignore it.
    // `nonblock` reaches the device too: one that can wait needs to know
    // whether it may. /dev/null ignores both and reads EOF.
    if(f.device) return f.device.read(max,this.pos(f),!!nonblock);
    if(f.type==='sock'){
      // `null` is the net's "nothing yet", and it becomes EAGAIN whether or not
      // the fd asked for non-blocking — because there is nothing to block ON.
      // The thread is the guest's and the answer would have to arrive on it;
      // with sockfetch it never happens anyway, since a response is in hand
      // before the guest stops writing.
      let data;
      try { data=this.net.recv(f.sock,max); }
      catch(e){ return { data:EMPTY, errno: wasiErrno(e) }; }
      if(data===null) return { data:EMPTY, errno:E.AGAIN };
      return { data, errno:0 };
    }
    if(f.type==='pipe'){
      const pi=this.pipes[f.pipe];
      if(!pi) return { data:EMPTY, errno:0 };
      let avail=-pi.off; for(const c of pi.chunks) avail+=c.length;
      const outb=new Uint8Array(Math.max(0,Math.min(max,avail))); let got=0;
      while(got<outb.length&&pi.chunks.length){ const c=pi.chunks[0]; const take=Math.min(outb.length-got,c.length-pi.off);
        outb.set(c.subarray(pi.off,pi.off+take),got); pi.off+=take; got+=take;
        if(pi.off===c.length){ pi.chunks.shift(); pi.off=0; } }
      return { data:outb, errno:0 };
    }
    if(f.type==='file'){
      const p=this.pos(f);
      if(f.gone){                            // unlinked while open: read the snapshot
        const take=Math.min(max,f.gone.data.length-p.v);
        if(take<=0) return { data:EMPTY, errno:0 };
        const data=f.gone.data.subarray(p.v,p.v+take); p.v+=take;
        return { data, errno:0 };
      }
      // statOf, not statAt: a store that FAILED here is not an empty file. Read
      // it as EOF and `cat` stops early, reporting success, having silently
      // truncated whatever it was piping.
      const { st, errno }=this.statOf(f.path);
      if(!st) return { data:EMPTY, errno:(errno==null||errno===E.NOENT)?0:errno };
      const take=Math.min(max,st.size-p.v);
      if(take<=0) return { data:EMPTY, errno:0 };
      // The range is clamped to the size the store just reported, so a short
      // read cannot leave uninitialized bytes in the buffer we hand back.
      const data=new Uint8Array(take);
      try { this.store.readSync(f.path,data,p.v,p.v+take); } catch(e) { return { data:EMPTY, errno:wasiErrno(e) }; }
      p.v+=take;
      return { data, errno:0 };
    }
    return { data:EMPTY, errno:0 };
  }
  // Write one buffer to one fd, routing on the fd TABLE TYPE — fd_write's whole
  // body minus the iovec gather. Host builtins go through it so their fd 1/fd 2
  // land wherever the shell last dup2'd them: a pipeline stage, a `> file`, a
  // $(...) capture. Calling this.stdout() instead would print `cmd | grep x`
  // straight to the terminal and hand grep an empty pipe — the same
  // fd-number-vs-fd-type mistake poll_oneoff already made once (see its
  // comment).
  //
  // BYTES ARE ALWAYS COPIED, and every branch below owes that for a different
  // reason. `b` is a view into the guest's linear memory — scratch space it
  // reuses on its next line — so anything that keeps it past the return keeps a
  // buffer whose contents are somebody else's business by then. worker.mjs
  // posts stdout with a transfer list, which would detach a handler's reused
  // buffer; a pipe holds its chunks until something reads them; and a store
  // that DEFERS its write, which every persistent one does, reads it after this
  // call is over. That last one was a live corruption: two files written
  // through one guest buffer both persisted as the second one's bytes, while
  // reads inside the session were right and flush() reported success.
  writeFd(fd,b){
    const f=this.fds.get(fd);
    if(!f) return E.BADF;
    if(f.type==='stdout') this.stdout(b.slice());
    else if(f.type==='stderr') this.stderr(b.slice());
    // A device can refuse: the host port answers EPERM with nothing behind it
    // and EIO when a verb fails. /dev/null returns nothing, which is 0.
    // Reporting those bytes as written would make a failed request look like a
    // delivered one.
    else if(f.device) return f.device.write(b,this.pos(f))||0;
    else if(f.type==='sock'){
      try { this.net.send(f.sock,b); }
      catch(e){ return wasiErrno(e); }
    }
    else if(f.type==='pipe'){ const pi=this.pipes[f.pipe]; if(pi&&b.length) pi.chunks.push(b.slice()); }
    else if(f.type==='file'){
      const p=this.pos(f);
      // An unlinked file still has its bytes and its offset; nobody else can
      // ever see them again, which is what POSIX says too.
      if(f.gone){
        const start=f.append?f.gone.data.length:p.v, end=start+b.length;
        if(end>f.gone.data.length){ const grown=new Uint8Array(end); grown.set(f.gone.data); f.gone.data=grown; }
        f.gone.data.set(b,start); p.v=end;
        return 0;
      }
      // O_APPEND means "at the end as it is NOW", so that one path has to ask
      // the store how big the file is; nothing else does. This used to stat on
      // EVERY write — a round trip a persistent store charges real time for,
      // once per iovec, and a stat that merely hiccuped then failed a write
      // that would have succeeded, reported as ENOENT whatever it really said.
      // A plain write goes straight through instead: the store's own error is
      // both the existence check and the reason, which conformance pins.
      let start=p.v;
      if(f.append){
        const st=this.statAt(f.path);
        if(!st) return E.NOENT;
        start=st.size;
      }
      // Copied, for the reason at the top of this method: a persistent store
      // writes back on a later turn of the event loop, and by then this
      // buffer is whatever the guest has since put there.
      try { this.store.writeSync(f.path,b.slice(),start); } catch(e) { return wasiErrno(e); }
      p.v=start+b.length;
    }
    return 0;
  }
  // The seek offset of an fd, as a SHARED CELL. POSIX gives dup/dup2 one file
  // offset per open file description, not per fd, and __host_dup/__host_dup2
  // copy the descriptor with {...src} — so a plain `off` number gave every dup
  // a private offset. Two real corruptions came from that: `cmd > f 2>&1` had
  // fd 1 and fd 2 both writing from 0 and overwriting each other, and the
  // fork-free evalpipe's fcntl(F_DUPFD,10)/dup2 save-restore REWOUND a
  // file-backed stdin between pipeline stages. Sharing the cell fixes both.
  // Lazy for non-file fds: pipes keep their offset on the pipe object and
  // stdio has none. fd_seek refuses both with ESPIPE, but a device still needs
  // a cell — /dev/host reads it as the identity of the open description an
  // exchange belongs to, not as an offset.
  pos(f){ return f.pos || (f.pos={v:0}); }
  // mkdir, shared by path_create_directory and a host builtin's ctx.fs.mkdir.
  makeDir(path){
    if(this.statAt(path)) return E.EXIST;
    if(this.ownsPath(path)) return E.PERM;   // the overlay would hide it
    try { this.store.mkdirSync(path,NEW_DIR); } catch(e) { return wasiErrno(e); }
    return 0;
  }
  // The FS as a small stable surface for host builtins, bound to the command's
  // cwd. Deliberately NOT the store itself: a builtin that held the store
  // could seek past this seam into whatever the embedder mounted, and the
  // narrow view is the same shape whichever store is underneath. read() copies
  // for the same reason writes never touched a mounted buffer — a builtin must
  // not be able to scribble one through the back door.
  hostFs(cwd){
    const w=this;
    const abs=(p)=>{ const s=String(p); return normalize(s.startsWith('/')?s:`${cwd.replace(/\/$/,'')}/${s}`); };
    return {
      resolve:abs,
      read(p){ const path=abs(p); const st=w.statAt(path);
        if(!st||isDir(st.mode)||st.device) return null;
        const out=new Uint8Array(st.size);
        try { if(st.size) w.store.readSync(path,out,0,st.size); } catch { return null; }
        return out; },
      write(p,data){ const path=abs(p); const st=w.statAt(path);
        if(st&&(isDir(st.mode)||st.device)) return false;
        if(!st&&w.ownsPath(path)) return false;
        const bytes=typeof data==='string'?strBytes(data):new Uint8Array(data);
        try {
          if(!st) w.store.createFileSync(path,NEW_FILE);
          // Write first, THEN trim the old tail. Truncating up front would
          // mean a store that refuses the write has already destroyed what was
          // there, while this call still reports failure.
          if(bytes.length) w.store.writeSync(path,bytes,0);
          w.store.touchSync(path,{size:bytes.length});
        } catch { return false; }
        return true; },
      exists(p){ return !!w.statAt(abs(p)); },
      stat(p){ const st=w.statAt(abs(p)); return st?{ type:isDir(st.mode)?'dir':'file', size:st.size }:null; },
      // The one store call here that can throw on its own: statAt already
      // swallows a failure into null, and a builtin gets null from every other
      // method rather than an exception through the middle of its run.
      list(p){ const path=abs(p); const st=w.statAt(path);
        if(!st||!isDir(st.mode)) return null;
        try { return w.readdirAt(path); } catch { return null; } },
      mkdir(p){ return w.makeDir(abs(p))===0; },
      remove(p){ const path=abs(p); const st=w.statAt(path); return st?w.removeNode(path,isDir(st.mode))===0:false; },
    };
  }
  // ---- the host port: /dev/host ----
  // One capability object, one virtual device, verbs instead of per-feature
  // plumbing. A request is a LINE written to /dev/host — a verb, optionally a
  // space and a payload — and the answer is read back from the same name:
  //
  //   printf 'clipboard.read\n' > /dev/host
  //   paste=$(cat /dev/host)
  //
  // Line framing rather than write boundaries, because a write boundary is not
  // one: stdio splits a large payload at its buffer size and the guest's own
  // `printf` decides where. A blank line is nothing; a line with no verb is a
  // malformed request and fails the write.
  //
  // The buffers belong to the SHIM, not to the fd. Those are two commands, two
  // opens and two closes — and a fork-free shell restores a redirection with
  // dup2, so a device fd frequently vanishes without fd_close ever seeing it.
  // Nothing here can be per-descriptor and survive.
  //
  // Security is a property of the port: no `host` and every capability is
  // absent, refused at open. Hand over one implementing only `clipboard.*` and
  // that is the whole of what a script can reach.
  hostDevice(){
    const w=this;
    let pending=EMPTY;          // a request line still waiting for its newline
    let response=[];            // answers not yet read back
    let responseLen=0;
    let writer=null;            // the open description the pending exchange belongs to
    // Diagnostics go to the shim's stderr SINK, never through writeFd(2). fd 2
    // can be redirected onto this very device (`cmd > /dev/host 2>/dev/host`),
    // and an error written there would re-enter the port in the middle of a
    // dispatch. The sink cannot be redirected, so there is no reentrancy to
    // guard against in the first place.
    const complain=(verb,msg)=>{ w.stderr(strBytes(`/dev/host: ${verb}: ${msg}\n`)); };
    const dispatch=(line)=>{
      if(!line.length) return 0;                       // a blank line is not a request
      let sp=line.indexOf(0x20);
      if(sp<0) sp=line.length;
      const verb=DEC.decode(line.subarray(0,sp));
      if(!verb){ complain('','a request line must start with a verb'); return E.INVAL; }
      // Copied, not viewed: `line` is a slice of the guest's linear memory and
      // a handler that retains its payload would be reading whatever the guest
      // put there next — or nothing at all, once memory.grow detaches it.
      const payload=line.slice(Math.min(sp+1,line.length));
      let out;
      // Contained exactly as a host builtin's throw is: a JS exception out of a
      // wasm import unwinds the entire guest stack and the instance is dead.
      // A broken verb costs one write.
      // Before the port hears the verb: a handler that answers by posting to
      // the page must not have its message overtake what the guest wrote first.
      if(w.beforeBlock) w.beforeBlock();
      try { out=w.host.request(verb,payload); }
      catch(e){ complain(verb,(e&&e.message)||e); return E.IO; }
      if(out&&typeof out.then==='function'){
        out.catch(()=>{});      // nobody owns this rejection
        complain(verb,'the port returned a Promise; a host verb must be synchronous, because the guest is a wasm frame below this call and there is nothing to await into (do async setup once, in serve({ async host() {…} }))');
        return E.IO;
      }
      const bytes=responseBytes(out);
      if(bytes===null){ complain(verb,'the port answered with something that is not bytes (expected a Uint8Array, a string, or nothing)'); return E.IO; }
      // Copied for the same reason writeFd copies: a handler is free to answer
      // out of a scratch buffer it reuses on the next verb.
      if(bytes.length){ response.push(bytes.slice()); responseLen+=bytes.length; }
      // Answers nobody reads are the other half of the unbounded-growth
      // problem the line cap covers. ENOSPC rather than EIO: the verb ran and
      // did its work; there is nowhere left to put what it said.
      if(responseLen>HOST_QUEUE_MAX) return E.NOSPC;
      return 0;
    };
    return {
      // Refused at OPEN, not at the first read: `cat /dev/host` has to say
      // "Permission denied" where a script can see it, rather than hand back a
      // silent EOF that reads as an empty answer.
      open:()=> w.host?0:E.PERM,
      read(max){
        if(!responseLen) return EMPTY;                 // drained: EOF, so `cat` stops
        const take=Math.min(max,responseLen);
        const out=new Uint8Array(take);
        let off=0;
        while(off<take){
          const c=response[0], n=Math.min(take-off,c.length);
          out.set(c.subarray(0,n),off); off+=n;
          if(n===c.length) response.shift(); else response[0]=c.subarray(n);
        }
        responseLen-=take;
        return out;
      },
      write(b,owner){
        if(!w.host) return E.PERM;
        // A NEW OPEN is a new exchange, and everything from the last one goes:
        // a queued answer nobody read, and a half-written request line. The
        // answer matters most — `echo verb > /dev/host; cat /dev/host` has to
        // mean the same thing whatever ran before it, and for a capability
        // port an unread answer surfacing in an unrelated `cat` is a leak and
        // not merely a surprise. The line matters too, because merging a
        // previous command's fragment into this one fabricates a request
        // neither wrote.
        //
        // Keyed on the open description rather than on the write, because one
        // batch legitimately arrives as many writes — `cat requests.txt >
        // /dev/host` is a single redirection whose chunks all belong together,
        // which is the same reason `pending` exists at all. The offset cell is
        // that identity: POSIX shares it across dup/dup2 and path_open makes a
        // fresh one per open, which is exactly the boundary wanted here.
        //
        // A WRITE open, precisely — and there is no symmetric check in read(),
        // deliberately. An exchange spans two opens by design (`echo verb >
        // /dev/host` then `$(cat /dev/host)`), so the read that collects an
        // answer and a later `cat` that finds one still sitting there are the
        // same thing seen from here: a fresh open description reading. Nothing
        // distinguishes them, which is why the boundary is the next request.
        if(owner!==writer){ writer=owner; pending=EMPTY; response=[]; responseLen=0; }
        const buf=pending.length?concatBytes(pending,b):b;
        let start=0, errno=0;
        for(;;){
          const nl=buf.indexOf(0x0a,start);
          if(nl<0) break;
          errno=dispatch(buf.subarray(start,nl));
          start=nl+1;
          // Stop at the first failure and drop the rest of this write. WASI has
          // one result, so an errno here fails the whole write(2) — dispatching
          // the remaining lines anyway would run requests the guest was just
          // told never happened.
          if(errno) break;
        }
        pending=(!errno&&start<buf.length)?buf.slice(start):EMPTY;
        // Sets errno rather than returning: an over-long line is a failed
        // write like any other, and returning here would step over the clear
        // below and leave this write's earlier answers readable.
        if(pending.length>HOST_LINE_MAX){ pending=EMPTY; errno=E.INVAL; }
        // A failed write leaves NOTHING to read. It told the guest that none
        // of this happened, and answers to the lines that did run would say
        // otherwise — while the response is precisely the signal a script is
        // told to trust, because a buffered writer may not check the status.
        // The side effects of a dispatched verb cannot be taken back; that is
        // what the stop-at-the-first-failure rule above is for.
        if(errno){ response=[]; responseLen=0; }
        return errno;
      },
    };
  }

  // The inbound half of the port: requests the HOST hands to a RUNNING guest.
  //
  // Nothing can be delivered to a live session by postMessage — a running guest
  // owns its worker and its event loop never turns — so the channel is shared
  // memory the guest reads at a blocking point. Which is why this is a device
  // and not a verb: a verb is the guest calling out, and here the guest is
  // WAITING TO BE TOLD.
  //
  // Framing is the vocabulary the outbound half already settled: a request is a
  // LINE. So the whole of a dev server is
  //
  //     while read -r req <&3; do handle "$req"; done 3< /dev/hostreq
  //
  // Redirected on the LOOP rather than with `exec`, because a failed `exec`
  // redirection ends a non-interactive shell outright — the refusal below is
  // worth more when the script is still there to act on it.
  //
  // and the two things it has to be told, it is told in the shell's own terms:
  //
  //   EPERM at open   this session can never receive a request. The loop
  //                   refuses to start, rather than parking forever on one.
  //   EOF at read     no more requests are coming. `read` returns non-zero and
  //                   the loop ends, exactly as it does on a closed pipe.
  //
  // There is no third answer, and that is deliberate: every other way an
  // inbound request can fail — a line with a newline in it, one too big for the
  // channel — is refused AT THE PRODUCER, where there is something to be done
  // about it. The guest has no write to fail and no $? to reach, so an error it
  // could only report by reading is an error it cannot act on.
  //
  // The reply goes back out through /dev/host, as an ordinary verb. One
  // direction per device, and no second vocabulary.
  requestDevice(){
    const w=this;
    return {
      open:()=> w.requests?0:E.PERM,
      // Offered unconditionally, because its PRESENCE is what stops poll_oneoff
      // calling this fd readable and putting the wait in the read behind it.
      // True at end-of-stream too — the read is what reports EOF.
      // Guarded like every other reach into an injected object: a channel
      // missing a method would throw out of a wasm import, which unwinds the
      // whole guest stack and kills the shell over a typo in an option.
      poll:(ms)=>{ const q=w.requests; if(!q||!q.pollReadable) return true;
        return q.pollReadable(ms) || !!(q.closed&&q.closed()); },
      read(max,owner,nonblock){
        if(!w.requests) return E.PERM;
        const r=w.readInput(w.requests,max,nonblock);
        return r.errno||r.data;
      },
      // No write half at all: the answer to a request is an outbound verb, and
      // addDevice's default says what a missing half means — nothing that may
      // be written, EPERM.
    };
  }
  // Drop a pipe's buffers once no fd references it (close/dup2 both funnel here).
  gcPipe(idx){
    for(const f of this.fds.values()) if(f.type==='pipe'&&f.pipe===idx) return;
    this.pipes[idx]=null;
  }
  // path_unlink_file / path_remove_directory: wantDir picks which is legal.
  removeNode(path,wantDir){
    const { st, errno }=this.statOf(path);
    if(!st) return errno;
    // The store says EISDIR here; unlink of a directory has answered EINVAL
    // since this shim's first line, and busybox's messages are tuned to it.
    if(wantDir!==isDir(st.mode)) return wantDir?E.NOTDIR:E.INVAL;
    if(st.device) return E.PERM;               // /dev is the shim's, not the guest's
    try {
      if(wantDir) this.store.rmdirSync(path);
      else {
        const cell=this.snapshotOpenFds(path,st);   // reads only
        this.store.unlinkSync(path);                // may throw: nothing committed yet
        this.adoptSnapshot(path,cell);
      }
    } catch(e) { return wasiErrno(e); }
    return 0;
  }
  str(p,len){ return DEC.decode(this.bytes().subarray(p,p+len)); }
  // NUL-terminated C string. Everything WASI hands us is (ptr,len); the host
  // builtin hooks are the first imports taking a bare char*, so there is no
  // length to pair with the pointer. The scan ends at the NUL or at the end of
  // linear memory, whichever comes first — a bad pointer costs one memchr and
  // cannot spin past the end comparing `undefined !== 0`. It must NOT end at a
  // byte budget: an argument longer than one would arrive shorter and still
  // well-formed, which is a wrong value rather than a failure, and a command
  // line carrying an encoded payload is exactly that argument.
  cstr(p){ if(!p) return ''; const u=this.bytes(); const e=u.indexOf(0,p); return DEC.decode(u.subarray(p,e<0?u.length:e)); }
  // NULL-terminated char** (argv, envp). Each element re-enters cstr, which
  // re-fetches the byte view, so a memory.grow mid-walk cannot leave us stale.
  // `cap` counts ELEMENTS, and the walk also stops at the end of memory: a
  // vector with no terminator is a bad pointer, not a long argv.
  cstrv(p,cap=4096){ const out=[]; if(!p) return out; const end=this.bytes().length-4; for(let q=p;out.length<cap&&q<=end;q+=4){ const s=this.dv().getUint32(q,true); if(!s) break; out.push(this.cstr(s)); } return out; }
  iovecs(iovs,n){ const out=[]; for(let i=0;i<n;i++){ const buf=this.dv().getUint32(iovs+i*8,true); const l=this.dv().getUint32(iovs+i*8+4,true); out.push(this.bytes().subarray(buf,buf+l)); } return out; }
  // Resolve a path given at an fd. A relative one is resolved against a
  // DIRECTORY, and against nothing else — which matters because of what fd 3
  // is. wasi-libc scans the preopen table once at startup, finds '/' at fd 3,
  // and from then on turns every absolute path in the program into a RELATIVE
  // one addressed through that number. A shell that redirects onto fd 3
  // (`exec 3< file`, or a `while read <&3` loop) has not asked for openat — it
  // has taken the root out from under every later open in the session, and
  // resolving against the file sitting there produced paths like
  // /data.txt/tmp/a: "nonexistent directory" for a directory that is right
  // there. Falling back to the root is what the preopen still means; a file or
  // a device is not a base and never was.
  resolve(fd,path){ if(path.startsWith('/')) return normalize(path); const f=this.fds.get(fd); const base=(f&&f.type==='dir'&&f.path)||'/'; return normalize(base.replace(/\/$/,'')+'/'+path); }
  // Introspection for tests and debugging, in the shape the private FS map
  // used to have. `data` is a getter because reading a whole file to answer a
  // stat would be absurd; nothing on a hot path goes through here.
  lookup(path){
    const st=this.statAt(path);
    if(!st) return null;
    const w=this, abs=normalize(path);
    return {
      type:isDir(st.mode)?'dir':(isChar(st.mode)?'char':'reg'), ino:st.ino, size:st.size,
      get data(){ const out=new Uint8Array(st.size); if(st.size&&!st.device) w.store.readSync(abs,out,0,st.size); return out; },
    };
  }
  // filestat: dev, ino, filetype, nlink, size, then atim/mtim/ctim in
  // NANOSECONDS. The times used to be three zeroes, which is invisible until
  // something caches by mtime and never notices an edit.
  writeFilestat(out,st){
    const d=this.dv();
    d.setBigUint64(out,st.device?DEV_DEV:1n,true);
    d.setBigUint64(out+8,BigInt(st.ino||0),true);
    d.setUint8(out+16,isDir(st.mode)?FT.DIR:(isChar(st.mode)?FT.CHAR:FT.REG));
    d.setBigUint64(out+24,BigInt(st.nlink ?? 1),true);   // ?? not ||: nlink 0 is real
    d.setBigUint64(out+32,BigInt(st.size||0),true);
    d.setBigUint64(out+40,msToNs(st.atimeMs),true);
    d.setBigUint64(out+48,msToNs(st.mtimeMs),true);
    d.setBigUint64(out+56,msToNs(st.ctimeMs),true);
  }
}

function strBytes(s){ return ENC.encode(s); }
function bytesOf(b){ return typeof b==='string'?strBytes(b):(b||EMPTY); }
function concatBytes(a,b){ const out=new Uint8Array(a.length+b.length); out.set(a); out.set(b,a.length); return out; }
function joinBytes(list){ let n=0; for(const b of list) n+=b.length; const out=new Uint8Array(n); let o=0; for(const b of list){ out.set(b,o); o+=b.length; } return out; }
// What a host verb may answer with. `null` means "none of these" — reported to
// the embedder rather than coerced, because every wrong shape here coerces to
// something plausible: a number is truthy with no .length, an object stringifies
// to [object Object], and both would reach the script as a silently empty or
// nonsensical response.
function responseBytes(out){
  if(out==null) return EMPTY;
  if(typeof out==='string') return strBytes(out);
  if(out instanceof Uint8Array) return out;
  if(out instanceof ArrayBuffer) return new Uint8Array(out);
  if(ArrayBuffer.isView(out)) return new Uint8Array(out.buffer,out.byteOffset,out.byteLength);
  return null;
}
function envObj(list){ const o={}; for(const kv of list){ const i=kv.indexOf('='); if(i>0) o[kv.slice(0,i)]=kv.slice(i+1); } return o; }
function parentOf(p){ const s=p.lastIndexOf('/'); return s>0?p.slice(0,s):'/'; }
function ownsDevPath(p){ return p==='/dev'||p.startsWith('/dev/'); }
function joinPath(dir,name){ return dir==='/'?`/${name}`:`${dir}/${name}`; }
function msToNs(ms){ return BigInt(Math.round((ms||0)*1e6)); }
// Write `files` into an INJECTED store, through the contract — mkdir -p, then
// replace. Only what the embedder passed as `files` is written: mounting a
// store is not a licence to reshape it.
function seedInto(store,files){
  // Only the lookup is allowed to fail meaninglessly here. Widening the catch
  // to cover the write would report a read-only store as EEXIST — the wrong
  // reason, at the point where the right one is the only useful thing.
  const present=(path)=>{ try { store.statSync(path); return true; } catch { return false; } };
  for(const [path,content] of Object.entries(files||{})){
    const abs=normalize(path.startsWith('/')?path:'/'+path);
    const segs=abs.split('/').filter(Boolean);
    let dir='';
    for(let i=0;i<segs.length-1;i++){
      dir=`${dir}/${segs[i]}`;
      if(!present(dir)) store.mkdirSync(dir,NEW_DIR);
    }
    if(!present(abs)) store.createFileSync(abs,NEW_FILE);
    const bytes=bytesOf(content);
    if(bytes.length) store.writeSync(abs,bytes,0);
    store.touchSync(abs,{size:bytes.length});
  }
}
