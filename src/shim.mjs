// Minimal WASI preview1 shim for the busybox ash wasm module: the imports
// busybox uses plus the env.__host_pipe/__host_dup/__host_dup2 hooks that back
// its fork-free pipes and fd juggling (see build/shim/wasistubs.c). Writable
// in-memory FS: mounted `files` plus anything the guest creates (O_CREAT needs
// an existing parent dir). Writes are copy-on-write — the caller's mounted
// buffers are never mutated — and all state vanishes with the run. /dev/null
// and in-memory pipes included. Stdin is pluggable (`input`) so the same shim
// serves scripted runs (fixed queue) and interactive sessions (SAB ring +
// Atomics.wait) in any JS environment.
//
// The `input` contract:
//   pollReadable(ms) -> bool     data available (waiting up to ms for some)
//   read(max)        -> bytes    non-blocking, possibly empty
//   readBlocking?(max) -> bytes  park until data or EOF (worker threads only)
//   wait?(ms)                    sleep for a poll timeout
//   closed?()        -> bool     no more data will ever arrive (stdin EOF)
//
// Usage:
//   const shim = new WasiShim({ args, env, files, stdout, stderr, input });
//   const { instance } = await WebAssembly.instantiate(module, shim.imports());
//   shim.bindMemory(instance.exports.memory);
//   try { instance.exports._start(); } catch (e) { if (!(e instanceof WasiExit)) throw e; }

export class WasiExit extends Error { constructor(code){ super('exit '+code); this.code=code; } }

const ENC = new TextEncoder();
const DEC = new TextDecoder();

const E = { SUCCESS:0, BADF:8, EXIST:20, INVAL:28, NOENT:44, NOSYS:52, NOTDIR:54, NOTEMPTY:55, NOTCAPABLE:76, AGAIN:6 };
const FT = { CHAR:2, DIR:3, REG:4 };

export class WasiShim {
  constructor({ args=['busybox'], env={}, files={}, stdout, stderr, input }) {
    this.args = args;
    this.env = Object.entries(env).map(([k,v]) => `${k}=${v}`);
    this.stdout = stdout || (() => {});
    this.stderr = stderr || this.stdout;
    this.input = input;                 // { pollReadable(ms)->bool, read(max)->Uint8Array }
    this.mem = null; this.view = null; this.u8 = null;
    // Build the FS: map of absolute path -> {type, data?, children?}
    this.fs = buildFs(files);
    // fd table. 0/1/2 std, 3 = preopen "/".
    this.fds = new Map();
    this.fds.set(0, { type:'stdin' });
    this.fds.set(1, { type:'stdout' });
    this.fds.set(2, { type:'stderr' });
    this.fds.set(3, { type:'dir', path:'/', preopen:true });
    this.nextFd = 4;
    this.pipes = [];
    // Inodes are handed out lazily per node. They must be UNIQUE: busybox
    // find/cp -r detect directory recursion by dev:ino pairs, and a constant
    // ino makes every directory look like a loop.
    this.nextIno = 2;
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
      proc_exit:(code)=>{ throw new WasiExit(code); },
      sched_yield:()=>0,
      random_get:(buf,len)=>{ const a=w.bytes().subarray(buf,buf+len);
        if(globalThis.crypto&&globalThis.crypto.getRandomValues){ for(let o=0;o<len;o+=65536) globalThis.crypto.getRandomValues(a.subarray(o,Math.min(o+65536,len))); }
        else { for(let i=0;i<len;i++)a[i]=(Math.random()*256)|0; }
        return 0; },
      fd_close:(fd)=>{ const f=w.fds.get(fd); w.fds.delete(fd); if(f&&f.type==='pipe') w.gcPipe(f.pipe); return 0; },
      fd_fdstat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const ft=f.type==='dir'?FT.DIR:(f.type==='file'?FT.REG:FT.CHAR); w.dv().setUint8(out,ft); w.dv().setUint16(out+2,0,true); w.dv().setBigUint64(out+8,~0n,true); w.dv().setBigUint64(out+16,~0n,true); return 0; },
      fd_fdstat_set_flags:(fd,flags)=>{ const f=w.fds.get(fd); if(f) f.nonblock=(flags&4)!==0; return 0; },
      fd_prestat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f||!f.preopen) return E.BADF; w.dv().setUint8(out,0); w.dv().setUint32(out+4,strBytes(f.path).length,true); return 0; },
      fd_prestat_dir_name:(fd,buf,len)=>{ const f=w.fds.get(fd); if(!f||!f.preopen) return E.BADF; w.bytes().set(strBytes(f.path).subarray(0,len),buf); return 0; },
      fd_filestat_get:(fd,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const node=f.node||{type:f.type==='dir'?'dir':'char'}; w.writeFilestat(out,node); return 0; },
      path_filestat_get:(fd,flags,pathp,plen,out)=>{ const path=w.resolve(fd,w.str(pathp,plen)); const node=w.lookup(path); if(!node) return E.NOENT; w.writeFilestat(out,node); return 0; },
      path_open:(fd,dflags,pathp,plen,oflags,rb,ri,fdflags,out)=>{
        // oflags: 1=CREAT 2=DIRECTORY 4=EXCL 8=TRUNC; fdflags: 1=APPEND
        const path=w.resolve(fd,w.str(pathp,plen)); let node=w.lookup(path);
        if(!node){
          if(!(oflags&1)) return E.NOENT;
          node=w.createFile(path);
          if(!node) return E.NOENT; // parent dir missing
        } else if((oflags&1)&&(oflags&4)) return E.EXIST;
        if(node.type==='reg'&&(oflags&8)){ node.data=new Uint8Array(0); node.mutable=true; }
        const nfd=w.nextFd++;
        if(node.type==='dir') w.fds.set(nfd,{type:'dir',path,node});
        else w.fds.set(nfd,{type:'file',path,node,off:0,append:(fdflags&1)!==0});
        w.dv().setUint32(out,nfd,true); return 0;
      },
      fd_read:(fd,iovs,n,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF;
        const bufs=w.iovecs(iovs,n); let total=0;
        if(f.type==='stdin'){
          let want=bufs.reduce((a,b)=>a+b.length,0);
          let data=w.input?w.input.read(want):new Uint8Array(0);
          if(data.length===0){
            // No data. A BLOCKING read must wait for input — else `while read`
            // sees failure and the app exits. A NON-blocking read gets EAGAIN
            // so `read -t` timeout logic runs. A CLOSED stdin reads 0 bytes
            // with SUCCESS — true EOF, so `while read` loops terminate.
            if(!f.nonblock && w.input && w.input.readBlocking){ data=w.input.readBlocking(want); }
            if(data.length===0){
              w.dv().setUint32(out,0,true);
              return (w.input && w.input.closed && w.input.closed()) ? 0 : E.AGAIN;
            }
          }
          let o=0; for(const b of bufs){ const take=Math.min(b.length,data.length-o); b.set(data.subarray(o,o+take)); o+=take; total+=take; if(o>=data.length)break; }
        }
        else if(f.node&&f.node.type==='char'){ total=0; /* /dev/null EOF */ }
        else if(f.type==='pipe'){ const pi=w.pipes[f.pipe];
          for(const b of bufs){ let got=0;
            while(pi&&got<b.length&&pi.chunks.length){ const c=pi.chunks[0]; const take=Math.min(b.length-got,c.length-pi.off);
              b.set(c.subarray(pi.off,pi.off+take),got); pi.off+=take; got+=take;
              if(pi.off===c.length){ pi.chunks.shift(); pi.off=0; } }
            total+=got; if(!pi||got<b.length)break; } }
        else if(f.node&&f.node.data){ if(f.off===undefined)f.off=0; const d=f.node.data; for(const b of bufs){ const take=Math.min(b.length,d.length-f.off); if(take<=0)break; b.set(d.subarray(f.off,f.off+take)); f.off+=take; total+=take; } }
        w.dv().setUint32(out,total,true); return 0; },
      fd_write:(fd,iovs,n,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const bufs=w.iovecs(iovs,n); let total=0;
        for(const b of bufs){ total+=b.length;
          if(f.type==='stdout') w.stdout(b.slice());
          else if(f.type==='stderr') w.stderr(b.slice());
          else if(f.node&&f.node.type==='char'){ /* /dev/null: discard */ }
          else if(f.type==='pipe'){ const pi=w.pipes[f.pipe]; if(pi&&b.length) pi.chunks.push(b.slice()); }
          else if(f.node&&f.node.type==='reg'){ const node=f.node;
            // Copy-on-write: never mutate a caller-mounted buffer.
            if(!node.mutable){ node.data=node.data?node.data.slice():new Uint8Array(0); node.mutable=true; }
            const start=f.append?node.data.length:(f.off||0); const end=start+b.length;
            if(end>node.data.length){ const nd=new Uint8Array(end); nd.set(node.data); node.data=nd; }
            node.data.set(b,start); f.off=end;
          }
        }
        w.dv().setUint32(out,total,true); return 0; },
      fd_seek:(fd,off,whence,out)=>{ const f=w.fds.get(fd); if(!f) return E.BADF; const sz=f.node&&f.node.data?f.node.data.length:0; off=Number(off); f.off=whence===0?off:whence===1?(f.off||0)+off:sz+off; w.dv().setBigUint64(out,BigInt(f.off||0),true); return 0; },
      fd_readdir:(fd,buf,len,cookie,out)=>{ const f=w.fds.get(fd); if(!f||f.type!=='dir') return E.BADF; const node=w.lookup(f.path); const ents=node?Object.keys(node.children||{}):[]; let p=buf; let idx=Number(cookie); let written=0;
        for(;idx<ents.length;idx++){ const name=ents[idx]; const nb=strBytes(name); const child=node.children[name]; const need=24+nb.length; if(p+need>buf+len)break;
          w.dv().setBigUint64(p,BigInt(idx+1),true); w.dv().setBigUint64(p+8,BigInt(idx+1),true); w.dv().setUint32(p+16,nb.length,true); w.dv().setUint8(p+20,child.type==='dir'?FT.DIR:FT.REG); w.bytes().set(nb,p+24); p+=need; written+=need; }
        w.dv().setUint32(out,written,true); return 0; },
      // ---- writable-FS ops (rm/mkdir/rmdir/mv and friends) ----
      path_unlink_file:(fd,pathp,plen)=>w.removeNode(w.resolve(fd,w.str(pathp,plen)),false),
      path_remove_directory:(fd,pathp,plen)=>w.removeNode(w.resolve(fd,w.str(pathp,plen)),true),
      path_create_directory:(fd,pathp,plen)=>{
        const path=w.resolve(fd,w.str(pathp,plen));
        if(w.lookup(path)) return E.EXIST;
        const parent=w.lookup(parentOf(path));
        if(!parent||parent.type!=='dir') return E.NOENT;
        w.fs[path]={type:'dir',children:{}};
        if(!parent.children) parent.children={};
        parent.children[path.slice(path.lastIndexOf('/')+1)]={type:'dir'};
        return 0;
      },
      path_rename:(fd,pathp,plen,nfd,npathp,nplen)=>{
        const from=w.resolve(fd,w.str(pathp,plen)), to=w.resolve(nfd,w.str(npathp,nplen));
        const node=w.lookup(from); if(!node) return E.NOENT;
        const tparent=w.lookup(parentOf(to));
        if(!tparent||tparent.type!=='dir') return E.NOENT;
        if(from===to) return 0;
        w.unlinkEntry(from);
        w.fs[to]=node;
        // the FS map is keyed by full path: a directory brings its subtree
        if(node.type==='dir'){
          const prefix=from+'/';
          for(const key of Object.keys(w.fs)){
            if(key.startsWith(prefix)){ w.fs[to+'/'+key.slice(prefix.length)]=w.fs[key]; delete w.fs[key]; }
          }
        }
        if(!tparent.children) tparent.children={};
        tparent.children[to.slice(to.lastIndexOf('/')+1)]={type:node.type};
        return 0;
      },
      // touch decides create-vs-update from this errno; times aren't stored.
      path_filestat_set_times:(fd,flags,pathp,plen)=>w.lookup(w.resolve(fd,w.str(pathp,plen)))?0:E.NOENT,
      // No symlinks exist in this FS: readlink's EINVAL means "not a symlink".
      path_readlink:()=>E.INVAL,
      path_symlink:()=>E.NOSYS,
      path_link:()=>E.NOSYS,
      poll_oneoff:(subs,events,nsubs,out)=>{
        // Parse subscriptions: a clock (timeout) and/or fd_read events. Events
        // must ECHO the subscription's userdata (WASI matches by it).
        let timeoutMs=null, clockUD=null, stdinUD=null, otherRead=null;
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
            if(f && f.type==='stdin') stdinUD=ud; else otherRead=ud; } }
        let nev=0;
        const emitRead=(ud)=>{ const ev=events+nev*32; w.dv().setBigUint64(ev,ud,true); w.dv().setUint16(ev+8,0,true); w.dv().setUint8(ev+10,1); w.dv().setBigUint64(ev+16,64n,true); w.dv().setUint16(ev+24,0,true); nev++; };
        const emitClock=(ud)=>{ const ev=events+nev*32; w.dv().setBigUint64(ev,ud,true); w.dv().setUint16(ev+8,0,true); w.dv().setUint8(ev+10,0); nev++; };
        // Non-stdin read subs (pipes/files) are regular fds -> always readable.
        if(otherRead!==null) emitRead(otherRead);
        if(stdinUD!==null){
          // A closed stdin is READABLE (POSIX: EOF wakes poll) — the caller
          // then reads and gets EOF instead of timing out forever.
          const closed = () => w.input && w.input.closed && w.input.closed();
          // pollReadable(ms) does the timed wait; when it comes back empty the
          // timeout has fully elapsed — report the clock, do NOT wait again.
          const ready = w.input && (w.input.pollReadable(timeoutMs==null?0:timeoutMs) || closed());
          if(ready) emitRead(stdinUD);
          else if(timeoutMs!=null) emitClock(clockUD);
          else emitRead(stdinUD); // blocking, no clock: report readable so caller reads (may EOF)
        } else if(otherRead===null && timeoutMs!=null){ if(w.input && w.input.wait) w.input.wait(timeoutMs); emitClock(clockUD); }
        w.dv().setUint32(out,nev,true); return 0; },
    };
    return {
      wasi_snapshot_preview1: p1,
      env: {
        __host_pipe:(fdptr)=>{ const idx=w.pipes.length; w.pipes.push({chunks:[],off:0}); const r=w.nextFd++, wr=w.nextFd++; w.fds.set(r,{type:'pipe',pipe:idx}); w.fds.set(wr,{type:'pipe',pipe:idx}); w.dv().setUint32(fdptr,r,true); w.dv().setUint32(fdptr+4,wr,true); return 0; },
        // F_DUPFD: lowest free fd >= minfd, sharing the source's backing.
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
      },
    };
  }
  // ---- helpers ----
  // Create an empty regular file (O_CREAT). Fails (null) unless the parent
  // directory already exists — matching "can't create" errors from a real sh.
  createFile(path){
    const slash=path.lastIndexOf('/'); const parent=slash>0?path.slice(0,slash):'/';
    const pnode=this.lookup(parent);
    if(!pnode||pnode.type!=='dir') return null;
    const node={type:'reg',data:new Uint8Array(0),mutable:true};
    this.fs[path]=node;
    if(!pnode.children) pnode.children={};
    pnode.children[path.slice(slash+1)]={type:'reg'};
    return node;
  }
  // Drop a pipe's buffers once no fd references it (close/dup2 both funnel here).
  gcPipe(idx){
    for(const f of this.fds.values()) if(f.type==='pipe'&&f.pipe===idx) return;
    this.pipes[idx]=null;
  }
  // Detach a path from the FS map and its parent's child list. Open fds keep
  // their node reference, so unlink-while-open reads keep working (POSIX-ish).
  unlinkEntry(path){
    delete this.fs[path];
    const parent=this.lookup(parentOf(path));
    if(parent&&parent.children) delete parent.children[path.slice(path.lastIndexOf('/')+1)];
  }
  // path_unlink_file / path_remove_directory: wantDir picks which is legal.
  removeNode(path,wantDir){
    const node=this.lookup(path);
    if(!node) return E.NOENT;
    if(wantDir!==(node.type==='dir')) return wantDir?E.NOTDIR:E.INVAL;
    if(wantDir&&node.children&&Object.keys(node.children).length) return E.NOTEMPTY;
    this.unlinkEntry(path);
    return 0;
  }
  str(p,len){ return DEC.decode(this.bytes().subarray(p,p+len)); }
  iovecs(iovs,n){ const out=[]; for(let i=0;i<n;i++){ const buf=this.dv().getUint32(iovs+i*8,true); const l=this.dv().getUint32(iovs+i*8+4,true); out.push(this.bytes().subarray(buf,buf+l)); } return out; }
  resolve(fd,path){ if(path.startsWith('/')) return normalize(path); const base=(this.fds.get(fd)||{}).path||'/'; return normalize(base.replace(/\/$/,'')+'/'+path); }
  lookup(path){ return this.fs[normalize(path)]||null; }
  writeFilestat(out,node){ const d=this.dv(); if(!node.ino) node.ino=this.nextIno++; d.setBigUint64(out,1n,true); d.setBigUint64(out+8,BigInt(node.ino),true); d.setUint8(out+16,node.type==='dir'?FT.DIR:(node.type==='char'?FT.CHAR:FT.REG)); d.setBigUint64(out+24,1n,true); d.setBigUint64(out+32,BigInt(node.data?node.data.length:0),true); for(const o of [40,48,56]) d.setBigUint64(out+o,0n,true); }
}

function strBytes(s){ return ENC.encode(s); }
function parentOf(p){ const s=p.lastIndexOf('/'); return s>0?p.slice(0,s):'/'; }
function normalize(p){ const parts=p.split('/').filter(x=>x&&x!=='.'); const st=[]; for(const x of parts){ if(x==='..')st.pop(); else st.push(x); } return '/'+st.join('/'); }
function buildFs(files){
  const fs={ '/':{type:'dir',children:{}}, '/dev':{type:'dir',children:{}}, '/dev/null':{type:'char'}, '/tmp':{type:'dir',children:{}} };
  fs['/'].children['dev']={type:'dir'}; fs['/'].children['tmp']={type:'dir'}; fs['/dev'].children['null']={type:'char'};
  for(const [path,content] of Object.entries(files)){
    const abs=normalize(path.startsWith('/')?path:'/'+path);
    const data=typeof content==='string'?strBytes(content):content;
    fs[abs]={type:'reg',data};
    // ensure parent dirs + child links
    const segs=abs.split('/').filter(Boolean); let cur='';
    for(let i=0;i<segs.length;i++){ const parent=cur||'/'; cur=(cur==='/'?'':cur)+'/'+segs[i]; if(i<segs.length-1){ if(!fs[cur])fs[cur]={type:'dir',children:{}}; if(!fs[parent].children)fs[parent].children={}; fs[parent].children[segs[i]]={type:'dir'}; } else { if(!fs[parent].children)fs[parent].children={}; fs[parent].children[segs[i]]={type:'reg'}; } }
  }
  return fs;
}
