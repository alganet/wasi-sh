// fetchTree(): assemble a { '/mounted/path': content } files map from URLs,
// for handing to run()/spawn(). Composes with object spread:
//   files: { ...await fetchTree({...}), '/extra.sh': '...' }
//
// Sources: either `manifestUrl` (a JSON array of relative paths — generate it
// however you like) or an explicit `paths` array. Every file is fetched from
// `baseUrl` in parallel.
//   mount            prefix inside the guest FS (default '/')
//   filter(rel)      keep a file (default: all)
//   transform(path, text)  rewrite text content before mounting (path is the
//                    mounted absolute path) — the hook that lets a consumer
//                    adapt sources to the sandbox without editing them
//   binary(rel)      fetch as bytes, skipping transform (default: none)
export async function fetchTree({
  manifestUrl,
  paths,
  baseUrl,
  mount = '/',
  filter,
  transform,
  binary,
} = {}) {
  if (!baseUrl) throw new Error('fetchTree: baseUrl is required');
  let rels = paths;
  if (!rels) {
    if (!manifestUrl) throw new Error('fetchTree: pass manifestUrl or paths');
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`fetchTree: manifest fetch failed: ${res.status} (${manifestUrl})`);
    rels = await res.json();
    if (!Array.isArray(rels)) throw new Error('fetchTree: manifest must be a JSON array of relative paths');
  }
  if (filter) rels = rels.filter(filter);
  const base = String(baseUrl).replace(/\/$/, '');
  const prefix = mount.replace(/\/$/, '');
  const files = {};
  await Promise.all(rels.map(async (rel) => {
    const res = await fetch(`${base}/${rel}`);
    if (!res.ok) throw new Error(`fetchTree: fetch failed: ${res.status} (${base}/${rel})`);
    const mounted = `${prefix}/${rel}`;
    if (binary && binary(rel)) {
      files[mounted] = new Uint8Array(await res.arrayBuffer());
    } else {
      const text = await res.text();
      files[mounted] = transform ? transform(mounted, text) : text;
    }
  }));
  return files;
}
