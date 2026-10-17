// Cloudflare Worker: secure save backend for hanny-site editor.
// Secrets (set in Cloudflare, never in the repo): GITHUB_TOKEN, EDIT_PASSWORD
const REPO = 'ofer911/hanny-site', BRANCH = 'main', SRC = 'font6.html', TARGETS = ['font6.html', 'index.html'];
const ORIGINS = ['https://ofer911.github.io'];

function cors(req) {
  const o = req.headers.get('Origin');
  return { 'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
}
const json = (req, obj, status = 200) => new Response(JSON.stringify(obj),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(req) } });

async function gh(env, path, opts = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { ...opts, headers: {
    Authorization: 'Bearer ' + env.GITHUB_TOKEN, 'User-Agent': 'hanny-editor', Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('GitHub ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}
function safeEq(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
const b64 = s => { const u = new TextEncoder().encode(s); let bin = ''; for (const c of u) bin += String.fromCharCode(c); return btoa(bin); };
const unb64 = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(req) });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET' && url.pathname === '/page') {
        const f = await gh(env, '/contents/' + SRC + '?ref=' + BRANCH);
        return json(req, { html: unb64(f.content), sha: f.sha });
      }
      if (req.method === 'POST' && (url.pathname === '/login' || url.pathname === '/save')) {
        const body = await req.json();
        if (!safeEq(body.password, env.EDIT_PASSWORD)) {
          await new Promise(r => setTimeout(r, 1500));
          return json(req, { ok: false, error: 'סיסמה שגויה' }, 401);
        }
        if (url.pathname === '/login') return json(req, { ok: true });
        const html = body.html;
        if (typeof html !== 'string' || html.length > 400000 || !/^<!doctype html>/i.test(html) || !html.includes('</html>'))
          return json(req, { ok: false, error: 'תוכן לא תקין' }, 400);
        // Single commit updating all targets (git data API)
        const ref = await gh(env, '/git/ref/heads/' + BRANCH);
        const parent = await gh(env, '/git/commits/' + ref.object.sha);
        const blob = await gh(env, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: b64(html), encoding: 'base64' }) });
        const tree = await gh(env, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: parent.tree.sha,
          tree: TARGETS.map(p => ({ path: p, mode: '100644', type: 'blob', sha: blob.sha })) }) });
        if (tree.sha === parent.tree.sha) return json(req, { ok: true, unchanged: true });
        const commit = await gh(env, '/git/commits', { method: 'POST', body: JSON.stringify({
          message: 'עדכון טקסטים מהעורך (Hanny editor)', tree: tree.sha, parents: [ref.object.sha] }) });
        await gh(env, '/git/refs/heads/' + BRANCH, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
        return json(req, { ok: true, commit: commit.sha });
      }
      return json(req, { error: 'not found' }, 404);
    } catch (e) { return json(req, { ok: false, error: String(e.message || e) }, 500); }
  }
};
