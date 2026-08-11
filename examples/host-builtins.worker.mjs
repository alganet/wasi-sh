// The worker half of examples/host-builtins.html.
//
// Host builtin handlers are FUNCTIONS, and postMessage structured-clones its
// payload — so they cannot be handed to a worker from the page. They are
// registered HERE, inside the worker, and the page points run() at this module
// with `workerUrl`.
//
// serve() is called SYNCHRONOUSLY, as the first thing this module does. A task
// cannot interleave with synchronous script evaluation, so a synchronous call
// always wins the startup message; if this module awaited first, that message
// would be delivered while it was suspended and the shell would quietly run
// with no builtins at all.
//
// Anything expensive goes inside builtins(), which serve() awaits BEFORE
// instantiating the module. That is the shape a real interpreter wants: boot
// once, asynchronously, up front — then every invocation is a synchronous call
// into something already warm. The handlers themselves must be synchronous;
// there is nothing for a Promise to resolve into while the guest is a wasm
// stack frame below you.
import { serve } from '../src/worker.mjs';

// Exported so the suite can drive these handlers headlessly (test/serve.test.mjs)
// — a factory is just a function, and keeping it separable costs nothing.
export async function builtins() {
  {
    // Stand-in for the real thing (compiling a wasm interpreter, opening OPFS,
    // fetching a dataset). It happens once, here, not per command.
    await Promise.resolve();
    const dec = new TextDecoder();

    // Read argv[1] as a file, or stdin when it is absent or "-". This is the
    // ordinary filter contract, and it is what makes a builtin composable.
    const input = (ctx, argIndex) => {
      const name = ctx.argv[argIndex];
      if (name && name !== '-') {
        const bytes = ctx.fs.read(name);        // resolved against ctx.cwd
        if (!bytes) { ctx.stderr(`${ctx.argv[0]}: ${name}: no such file\n`); return null; }
        return dec.decode(bytes);
      }
      return dec.decode(ctx.stdin());
    };

    return {
      // json PATH [FILE] — pull a value out of JSON with a dotted path.
      // The guest has no JSON parser; the host has had one all along.
      json(ctx) {
        const path = ctx.argv[1];
        if (!path) { ctx.stderr('usage: json PATH [FILE]\n'); return 2; }
        const text = input(ctx, 2);
        if (text === null) return 1;
        let value;
        try { value = JSON.parse(text); }
        catch (e) { ctx.stderr(`json: ${e.message}\n`); return 1; }
        for (const key of path.split('.').filter(Boolean)) {
          const m = /^(.*?)\[(\d+)\]$/.exec(key);
          if (m) {
            if (m[1]) value = value?.[m[1]];
            value = value?.[Number(m[2])];
          } else {
            value = value?.[key];
          }
          if (value === undefined) { ctx.stderr(`json: no such path: ${path}\n`); return 1; }
        }
        ctx.stdout(typeof value === 'object' ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`);
        return 0;
      },

      // num [LOCALE] — format each line as a locale-aware number. Reads the
      // shell's LANG unless told otherwise, so `... | LANG=de-DE num` works:
      // the environment a builtin sees is ash's live one, exports and VAR=x
      // prefixes included. (The prefix goes on the stage that needs it —
      // `LANG=de-DE json … | num` would set it for `json`, not for `num`.)
      num(ctx) {
        // wasi-sh defaults LANG to C.UTF-8, and C/POSIX is the "no
        // localization" locale — which Intl rejects rather than ignores.
        const tag = (ctx.argv[1] || ctx.env.LANG || '').split('.')[0].replace('_', '-');
        const locale = (!tag || tag === 'C' || tag === 'POSIX') ? 'en-US' : tag;
        let fmt;
        try { fmt = new Intl.NumberFormat(locale); }
        catch { ctx.stderr(`num: bad locale: ${locale}\n`); return 2; }
        let bad = 0;
        for (const line of dec.decode(ctx.stdin()).split('\n')) {
          if (!line.trim()) continue;
          const n = Number(line);
          if (Number.isNaN(n)) { ctx.stderr(`num: not a number: ${line}\n`); bad = 1; continue; }
          ctx.stdout(`${fmt.format(n)}\n`);
        }
        return bad;
      },
    };
  }
}

serve({ builtins });
