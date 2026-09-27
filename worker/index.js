// Worker WikiMap : sert le site statique, et un compteur de visites public.
//   POST /api/visit  compte une visite et renvoie le total   → { "visits": 1234 }
//   GET  /api/visit  renvoie le total sans compter
// Le compteur est un seul nombre (table counter de la base D1, voir worker/schema.sql) : aucune
// donnée sur les visiteurs (ni adresse IP, ni cookie, ni identifiant) n'est enregistrée.
//
// Aperçu privé : tant que le secret SITE_PASSWORD existe, tout le site demande un mot de passe
// (authentification HTTP du navigateur, identifiant libre). Pour ouvrir le site au public :
//   npx wrangler secret delete SITE_PASSWORD
const enc = new TextEncoder();
function authorized(request, password) {
  const m = /^Basic (.+)$/.exec(request.headers.get('authorization') || '');
  if (!m) return false;
  let given = '';
  try { given = atob(m[1]).split(':').slice(1).join(':'); } catch (e) { return false; }
  const a = enc.encode(given), b = enc.encode(password);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    if (env.SITE_PASSWORD && !authorized(request, env.SITE_PASSWORD)) {
      return new Response('Aperçu privé de WikiMap : identifiant et mot de passe requis.', {
        status: 401,
        headers: { 'www-authenticate': 'Basic realm="WikiMap (aperçu privé)", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    const url = new URL(request.url);
    if (url.pathname !== '/api/visit') return env.ASSETS.fetch(request);
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
    try {
      if (request.method === 'POST') {
        const row = await env.DB.prepare("update counter set n = n + 1 where id = 'visits' returning n").first();
        return json({ visits: row ? row.n : 0 });
      }
      if (request.method === 'GET') {
        const row = await env.DB.prepare("select n from counter where id = 'visits'").first();
        return json({ visits: row ? row.n : 0 });
      }
      return json({ error: 'méthode non prise en charge' }, 405);
    } catch (e) {
      return json({ error: 'compteur indisponible' }, 503);
    }
  },
};
