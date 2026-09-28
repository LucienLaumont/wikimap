// WikiMap — visionneuse de la carte des co-achats (données : data/graph.json, produit par
// pipeline/graph.py puis pipeline/layout.mjs). Carte dessinée en WebGL 2 (render-gl.js), étiquettes et
// mise en avant en Canvas 2D ; sans WebGL 2, tout est dessiné en Canvas 2D (drawScene).
(() => {
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
  const SMALL = 5; // groupes plus petits : gris, sans nom ni zone sur la carte
  const NARROW = 640;
  const CURVE = 0.18; // courbure des liens : décalage du milieu, en part de leur longueur
  const ZONE_RES = 0.5; // résolution du calque des zones de groupe, en pixels par point d'écran (taches floues)
  // Trois calques superposés : fond et grille (Canvas 2D) ; la carte (liens, zones, cartes), en WebGL ;
  // l'écran (#map), qui reçoit les gestes et porte étiquettes, survol et sélection. Survoler une carte ne
  // redessine que l'écran. Sans WebGL 2, la carte est dessinée en Canvas 2D sur sceneLayer puis recopiée.
  const canvas = document.getElementById('map'), screen = canvas.getContext('2d');
  const gridCanvas = document.createElement('canvas'), gridCtx = gridCanvas.getContext('2d'), glCanvas = document.createElement('canvas');
  // placés ici plutôt que dans map.css : un ancien map.css gardé en cache les laisserait hors de la vue
  for (const c of [gridCanvas, glCanvas]) Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
  canvas.before(gridCanvas, glCanvas);
  const glr = window.WikiGL ? WikiGL.create(glCanvas) : null;
  let useGL = !!glr;
  if (!useGL) glCanvas.remove();
  // toute erreur de la carte graphique (pilote exotique, contexte perdu) : on passe en Canvas 2D plutôt que
  // d'afficher une carte vide
  function glFail(e) { console.warn('WebGL, passage en Canvas 2D :', e && e.message || e); useGL = false; glCanvas.remove(); dirty = true; }
  let sceneLayer = document.createElement('canvas'), backLayer = document.createElement('canvas');
  const $ = (id) => document.getElementById(id);
  // séparateur de milliers : espace insécable ordinaire, Sora n'a pas l'espace fine du format français
  const nf = new Intl.NumberFormat('fr-FR'), fmt = { format: (n) => nf.format(n).replace(/ /g, ' ') };
  const fmtDay = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
  const fmtDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const compact = (n) => n >= 1e6 ? (n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M' : fmt.format(n);

  let N, E, interE, GR, adj, order, grid, gridSize = 400, sMax = 1, kMin = 0, layouts = {};
  let W = 0, H = 0, dpr = 1, cam = { x: 0, y: 0, k: 1 }, kFit = 1;
  // dirty : la scène est à refaire (données, filtres, sélection, thème) ; repaint : l'écran seul (survol)
  let hidden = new Set(), selected = -1, selGroup = -1, hover = -1, dirty = true, repaint = false;
  let shownCam = { x: NaN, y: NaN, k: NaN }, hl = null; // hl : mise en avant courante (highlight())
  let colorMode = 'group', colors = {}, groupCol = [], groupText = [], fonts = {}, detailGroup = -1;
  const zoneLayer = document.createElement('canvas'), zctx = zoneLayer.getContext('2d');

  // ---- couleurs (lues sur les jetons CSS : suivent le thème)
  function readColors() {
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    colors = { edge: v('--edge'), edgeAlpha: parseFloat(v('--edge-alpha')), ink: v('--ink'), bg: v('--bg'), accent: v('--accent'), muted: v('--muted'), small: v('--group-small') };
    for (const r of RARITIES) colors[r] = v('--r-' + r);
    colors.zoneAlpha = parseFloat(v('--zone-alpha')); colors.linkAlpha = parseFloat(v('--link-alpha'));
    colors.grat = v('--grat'); colors.gratAlpha = parseFloat(v('--grat-alpha')); colors.glow = parseFloat(v('--glow')) || 0;
    // noms de groupes : police, graisse et épaisseur du contour (couleur du fond) qui les détache de la carte
    fonts = { display: v('--font-display'), body: v('--font-body'), labelWeight: v('--label-weight') || '600', labelHalo: parseFloat(v('--label-halo')) || 3.5 };
    const hue = (g) => (g.id * 137.508) % 360;
    if (GR) {
      groupCol = GR.map((g) => g.size < SMALL ? colors.small : `hsl(${hue(g)}, ${v('--group-s')}, ${v('--group-l')})`);
      groupText = GR.map((g) => g.size < SMALL ? colors.muted : `hsl(${hue(g)}, ${v('--group-s')}, ${v('--group-text-l')})`);
      if (detailGroup >= 0) $('detail').style.setProperty('--gcol', groupCol[detailGroup]);
      if (useGL) try {
        const rgba = new Uint8Array(GR.length * 4);
        groupCol.forEach((c, k) => rgba.set([...rgb(c).map((v) => Math.round(v * 255)), 255], k * 4));
        glr.setGroupColors(rgba, GR.length);
      } catch (e) { glFail(e); }
    }
    glColors = { edge: rgb(`rgb(${colors.edge})`), accent: rgb(colors.accent), rar: new Float32Array(24) };
    [...RARITIES, 'muted'].forEach((r, k) => glColors.rar.set(rgb(colors[r]), k * 3));
    syncThemeBtn();
    dirty = true;
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // couleur CSS -> [r, g, b] entre 0 et 1 (le canvas normalise la couleur en #rrggbb ou rgba(...))
  const cvt = document.createElement('canvas').getContext('2d');
  function rgb(s) {
    cvt.fillStyle = '#000'; cvt.fillStyle = s || '#000';
    const v = cvt.fillStyle;
    return v[0] === '#' ? [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16) / 255) : v.match(/[\d.]+/g).slice(0, 3).map((x) => +x / 255);
  }
  let glColors = null;
  const rarIdx = (r) => { const k = RARITIES.indexOf(r); return k < 0 ? RARITIES.length : k; };
  const fillOf = (n) => colorMode === 'group' ? groupCol[n.group] : (colors[n.rarity] || colors.muted);
  const groupName = (g) => g.name || g.top.slice(0, 2).join(' · '); // nom (names.json) ou, à défaut, ses cartes phares

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = gridCanvas.width = sceneLayer.width = backLayer.width = W * dpr; canvas.height = gridCanvas.height = sceneLayer.height = backLayer.height = H * dpr;
    if (useGL) try { glr.resize(W, H, dpr, ZONE_RES); } catch (e) { glFail(e); }
    zoneLayer.width = Math.ceil(W * ZONE_RES); zoneLayer.height = Math.ceil(H * ZONE_RES);
    dirty = true;
  }
  new ResizeObserver(resize).observe($('stage'));

  const sx = (x) => (x - cam.x) * cam.k + W / 2, sy = (y) => (y - cam.y) * cam.k + H / 2;
  // n.size : rayon dans l'unité des positions (layout.mjs, cercles sans chevauchement), grandit avec
  // la force des liens. Il suit le zoom comme sur une carte ; vue de loin, kMin garde les points visibles.
  const radius = (n) => n.size * Math.max(cam.k, kMin);
  const visible = (i) => !hidden.has(N[i].rarity);
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  // ---- disposition
  function setLayout(name) {
    const xy = layouts[name].xy;
    N.forEach((n, i) => { n.x = xy[2 * i]; n.y = xy[2 * i + 1]; });
    if (useGL) try { glr.setPositions(posArray()); } catch (e) { glFail(e); }
    grid = new Map();
    N.forEach((n, i) => { const k = Math.floor(n.x / gridSize) + ',' + Math.floor(n.y / gridSize); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    GR.forEach((g) => { g.members = []; });
    N.forEach((n, i) => GR[n.group].members.push(i));
    GR.forEach(core);
    for (const b of $('layout-mode').children) b.setAttribute('aria-pressed', String(b.dataset.v === name));
    fit();
    if (selGroup >= 0) flyToGroup(GR[selGroup]); else if (selected >= 0) flyTo(N[selected]);
  }
  // Cœur d'un groupe, là où poser son nom : certains groupes sont coupés en morceaux éloignés, et
  // leur centre de gravité tombe dans le vide. On part de la carte la plus centrale du groupe (plus
  // forte somme de liens) et on se recentre sur ses voisines (moyenne des 40 % les plus proches, 6 fois).
  function core(g) {
    const pts = g.members.map((i) => N[i]), top = pts.reduce((a, b) => (b.strength > a.strength ? b : a));
    let cx = top.x, cy = top.y;
    for (let it = 0; it < 6; it++) {
      const near = pts.map((p) => [Math.hypot(p.x - cx, p.y - cy), p]).sort((a, b) => a[0] - b[0]).slice(0, Math.max(3, Math.ceil(pts.length * 0.4)));
      cx = near.reduce((t, [, p]) => t + p.x, 0) / near.length; cy = near.reduce((t, [, p]) => t + p.y, 0) / near.length;
    }
    g.cx = cx; g.cy = cy;
  }
  function fitView() {
    const xs = N.map((n) => n.x).sort((a, b) => a - b), ys = N.map((n) => n.y).sort((a, b) => a - b);
    const q = (a, p) => a[Math.floor(a.length * p)];
    const x0 = q(xs, 0.01), x1 = q(xs, 0.99), y0 = q(ys, 0.01), y1 = q(ys, 0.99), narrow = W < NARROW;
    const k = Math.min((W - (narrow ? 32 : 340)) / (x1 - x0), (H - (narrow ? 120 : 40)) / (y1 - y0));
    return { x: (x0 + x1) / 2 - (narrow ? 0 : 150 / k), y: (y0 + y1) / 2, k };
  }
  function fit() { const v = fitView(); cam.x = v.x; cam.y = v.y; cam.k = kFit = v.k; dirty = true; }

  function pick(px, py) {
    const wx = (px - W / 2) / cam.k + cam.x, wy = (py - H / 2) / cam.k + cam.y;
    const reach = 14 / cam.k, g0x = Math.floor((wx - reach) / gridSize), g1x = Math.floor((wx + reach) / gridSize);
    const g0y = Math.floor((wy - reach) / gridSize), g1y = Math.floor((wy + reach) / gridSize);
    let best = -1, bd = Infinity;
    for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy <= g1y; gy++) {
      for (const i of grid.get(gx + ',' + gy) || []) {
        if (!visible(i)) continue;
        const d = Math.hypot(sx(N[i].x) - px, sy(N[i].y) - py);
        if (d < Math.max(6, radius(N[i]) + 3) && d < bd) { bd = d; best = i; }
      }
    }
    return best;
  }

  // ---- dessin
  // Tracés groupés : un seul trait ou remplissage par couleur (et opacité, épaisseur), au lieu d'un
  // par lien ou par carte. Le navigateur passe l'essentiel du temps à lancer les tracés, pas à les calculer.
  const batch = (m, key, props) => { let b = m.get(key); if (!b) m.set(key, b = { path: new Path2D(), ...props }); return b.path; };
  const textWidth = new Map(); // largeur des étiquettes, par police et texte : measureText est lent
  // Étiquettes toutes faites : chaque texte (avec son contour couleur du fond) est dessiné une fois dans
  // une petite image, puis recopié à chaque image ; dessiner du texte est lent, surtout sur écran haute
  // résolution. Vidé au-delà de 4 000 (on a beaucoup zoomé et parcouru).
  const labelCache = new Map(), LABEL_H = 24;
  function labelSprite(text, font, color, halo, w) {
    const key = dpr + '|' + font + '|' + color + '|' + halo + '|' + colors.bg + '|' + text;
    let s = labelCache.get(key);
    if (!s) {
      if (labelCache.size > 4000) labelCache.clear();
      const pad = Math.ceil(halo) + 2;
      s = document.createElement('canvas');
      s.width = Math.ceil((w + 2 * pad) * dpr); s.height = Math.ceil(LABEL_H * dpr);
      const c = s.getContext('2d');
      c.scale(dpr, dpr); c.font = font; c.textBaseline = 'middle'; c.lineJoin = 'round';
      c.lineWidth = halo; c.strokeStyle = colors.bg; c.strokeText(text, pad, LABEL_H / 2);
      c.fillStyle = color; c.fillText(text, pad, LABEL_H / 2);
      s.pad = pad;
      labelCache.set(key, s);
    }
    return s;
  }

  // mise en avant : une carte (elle et ses voisines) ou un groupe (lui, puis ses groupes liés)
  function highlight() {
    const nbSet = selected >= 0 ? new Set(adj[selected].map((a) => a[0])) : null;
    const linked = selGroup >= 0 ? new Set(Object.keys(GR[selGroup].links).map(Number)) : null;
    const alphaOf = (i) => {
      const n = N[i], base = 0.5 + 0.5 * Math.min(1, n.strength / sMax);
      if (nbSet) return i === selected || nbSet.has(i) ? base : 0.12;
      if (linked) return n.group === selGroup ? base : linked.has(n.group) ? 0.4 : 0.07;
      return base;
    };
    return { nbSet, linked, alphaOf };
  }
  // fonctions de position pour une caméra jc
  const viewOf = (jc) => ({
    sx: (x) => (x - jc.x) * jc.k + W / 2, sy: (y) => (y - jc.y) * jc.k + H / 2,
    radius: (n) => n.size * Math.max(jc.k, kMin), on: (x, y) => x > -50 && x < W + 50 && y > -50 && y < H + 50,
  });

  // Sans WebGL : dessine la carte pour la caméra jc sur ctx, en Canvas 2D, étiquettes comprises
  function drawScene(jc, ctx, { nbSet, linked, alphaOf }) {
    const { sx, sy, radius, on } = viewOf(jc);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Liens en arc léger (courbe quadratique), toujours bombés du même côté pour qu'un faisceau de
    // liens parallèles reste rangé. Ordre de dessin : liens, puis zones de groupe par-dessus (les
    // groupes dominent), puis ce qui est sélectionné, puis les cartes.
    const arc = (p, x1, y1, x2, y2) => {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      p.moveTo(x1, y1); p.quadraticCurveTo(mx - (y2 - y1) * CURVE, my + (x2 - x1) * CURVE, x2, y2);
    };
    const offscreen = (x1, y1, x2, y2) => Math.max(x1, x2) < -40 || Math.min(x1, x2) > W + 40 || Math.max(y1, y2) < -40 || Math.min(y1, y2) > H + 40;
    // liens entre groupes : coupés en leur milieu, chaque moitié à la couleur du groupe de son bout (le
    // dégradé d'un groupe à l'autre, sans un dégradé par lien) ; épaisseur arrondie au demi-pixel
    const interLinks = (only, alpha, width) => {
      const paths = new Map();
      for (const [a, b, w] of interE) {
        const ga = N[a].group, gb = N[b].group;
        if (only >= 0 && ga !== only && gb !== only) continue;
        if (!visible(a) || !visible(b)) continue;
        const x1 = sx(N[a].x), y1 = sy(N[a].y), x2 = sx(N[b].x), y2 = sy(N[b].y);
        if (offscreen(x1, y1, x2, y2)) continue;
        const qx = (x1 + x2) / 2 - (y2 - y1) * CURVE, qy = (y1 + y2) / 2 + (x2 - x1) * CURVE;
        const hx = (x1 + 2 * qx + x2) / 4, hy = (y1 + 2 * qy + y2) / 4; // milieu de la courbe
        const lw = Math.max(1, Math.round(width(w) * 2));
        const straight = Math.abs(x2 - x1) + Math.abs(y2 - y1) < 24;
        let p = batch(paths, ga * 16 + lw, { g: ga, lw });
        p.moveTo(x1, y1); straight ? p.lineTo(hx, hy) : p.quadraticCurveTo((x1 + qx) / 2, (y1 + qy) / 2, hx, hy);
        p = batch(paths, gb * 16 + lw, { g: gb, lw });
        p.moveTo(hx, hy); straight ? p.lineTo(x2, y2) : p.quadraticCurveTo((qx + x2) / 2, (qy + y2) / 2, x2, y2);
      }
      ctx.globalAlpha = alpha;
      for (const { path, g, lw } of paths.values()) { ctx.strokeStyle = groupCol[g]; ctx.lineWidth = lw / 2; ctx.stroke(path); }
      ctx.globalAlpha = 1;
    };

    // liens internes aux groupes : gris, discrets, tous affichés ; ceux de moins de 3 px à l'écran (vue
    // d'ensemble) se perdent sous les zones, les courts sont tracés droits (la courbure ne se voit pas)
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = `rgba(${colors.edge},${nbSet || linked ? colors.edgeAlpha * 0.4 : colors.edgeAlpha})`;
    const intra = new Path2D();
    for (const [a, b] of E) {
      if (N[a].group !== N[b].group || !visible(a) || !visible(b)) continue;
      const x1 = sx(N[a].x), y1 = sy(N[a].y), x2 = sx(N[b].x), y2 = sy(N[b].y);
      if (offscreen(x1, y1, x2, y2)) continue;
      const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      if (len < 3) continue;
      if (len < 12) { intra.moveTo(x1, y1); intra.lineTo(x2, y2); } else arc(intra, x1, y1, x2, y2);
    }
    ctx.stroke(intra);
    if (!nbSet && !linked) interLinks(-1, colors.linkAlpha, (w) => 0.5 + w * 2.5);

    // zones de groupe (« flaques ») : un disque large sous chaque carte, dessiné opaque sur un calque
    // à part (à demi-résolution : ses bords sont doux) puis posé en transparence ; les disques voisins
    // se fondent en une seule zone
    zctx.setTransform(ZONE_RES, 0, 0, ZONE_RES, 0, 0);
    zctx.clearRect(0, 0, W, H);
    for (const g of GR) {
      if (g.size < SMALL || (linked && g.id !== selGroup && !linked.has(g.id))) continue;
      zctx.fillStyle = groupCol[g.id];
      zctx.beginPath();
      for (const i of g.members) {
        if (!visible(i)) continue;
        const n = N[i], x = sx(n.x), y = sy(n.y), zr = Math.max(radius(n) * 2.6, 7);
        if (x < -zr || x > W + zr || y < -zr || y > H + zr) continue;
        zctx.moveTo(x + zr, y); zctx.arc(x, y, zr, 0, Math.PI * 2);
      }
      zctx.fill();
    }
    ctx.globalAlpha = nbSet ? colors.zoneAlpha * 0.5 : colors.zoneAlpha;
    ctx.drawImage(zoneLayer, 0, 0, W, H);
    ctx.globalAlpha = 1;

    // sélection : les liens du groupe choisi, ou ceux de la carte choisie, bien visibles
    if (linked) interLinks(selGroup, 0.85, (w) => 0.8 + w * 4);
    if (nbSet) {
      ctx.strokeStyle = colors.accent; ctx.globalAlpha = 0.75;
      const x0 = sx(N[selected].x), y0 = sy(N[selected].y);
      for (const [j, w] of adj[selected]) {
        if (!visible(j)) continue;
        ctx.lineWidth = 0.8 + w * 5;
        ctx.beginPath(); arc(ctx, x0, y0, sx(N[j].x), sy(N[j].y)); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // cartes, par lots de même couleur et même opacité (arrondie au 1/20) : halos (thème sombre),
    // disques, puis anneaux de rareté en mode groupe, dès que le point est assez grand
    const glows = new Map(), fills = new Map(), rings = new Map(), TAU = Math.PI * 2;
    for (const i of order) {
      if (!visible(i)) continue;
      const n = N[i], x = sx(n.x), y = sy(n.y);
      if (!on(x, y)) continue;
      const r = radius(n), a = Math.round(alphaOf(i) * 20) / 20, col = fillOf(n);
      // thème sombre : halo autour des cartes centrales, comme des étoiles
      if (colors.glow && r >= 2.5 && n.strength >= sMax * 0.5) {
        let p = batch(glows, col + '|' + a * colors.glow * 0.5, { col, a: a * colors.glow * 0.5 });
        p.moveTo(x + r * 2.4, y); p.arc(x, y, r * 2.4, 0, TAU);
        p = batch(glows, col + '|' + a * colors.glow, { col, a: a * colors.glow });
        p.moveTo(x + r * 1.6, y); p.arc(x, y, r * 1.6, 0, TAU);
      }
      const p = batch(fills, col + '|' + a, { col, a });
      if (r < 1.5) p.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8); // tout petit : un carré de même surface visible
      else { p.moveTo(x + r, y); p.arc(x, y, r, 0, TAU); }
      if (colorMode === 'group' && r >= 3.5) {
        const lw = Math.max(1, Math.round(r * 0.6) / 2), rc = colors[n.rarity] || colors.muted;
        const q = batch(rings, rc + '|' + a + '|' + lw, { col: rc, a, lw });
        q.moveTo(x + r - lw / 2, y); q.arc(x, y, r - lw / 2, 0, TAU);
      }
    }
    for (const { path, col, a } of glows.values()) { ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fill(path); }
    for (const { path, col, a } of fills.values()) { ctx.globalAlpha = a; ctx.fillStyle = col; ctx.fill(path); }
    for (const { path, col, a, lw } of rings.values()) { ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(path); }
    ctx.globalAlpha = 1;
    drawLabels(ctx, jc, { nbSet, linked, alphaOf });
  }

  // étiquettes, sans chevauchement : noms de groupes vue de loin, noms de cartes en zoomant ; les
  // boîtes déjà posées sont rangées dans une grille de 64 px pour ne comparer qu'aux voisines
  function drawLabels(ctx, jc, { nbSet, linked, alphaOf }) {
    const { sx, sy, radius, on } = viewOf(jc);
    const CELL = 64, cells = new Map(), zoom = jc.k / kFit;
    const eachCell = (b, fn) => {
      for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++)
        for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) if (fn(gx + ',' + gy)) return true;
      return false;
    };
    const put = (text, x, y, font, color, anchor, halo = 3.5) => {
      const tk = font + '\n' + text;
      let w = textWidth.get(tk);
      if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; textWidth.set(tk, w); }
      const x0 = anchor === 'center' ? x - w / 2 : x;
      const box = [x0 - 3, y - 9, x0 + w + 3, y + 9];
      if (box[2] < 0 || box[0] > W || box[3] < 0 || box[1] > H) return false;
      if (eachCell(box, (k) => (cells.get(k) || []).some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]))) return false;
      eachCell(box, (k) => { (cells.get(k) || cells.set(k, []).get(k)).push(box); });
      // recopiée pixel pour pixel (taille exacte, position calée sur la grille des pixels réels) :
      // la moindre mise à l'échelle ou position entre deux pixels rendrait le texte flou
      const s = labelSprite(text, font, color, halo, w);
      ctx.drawImage(s, Math.round((x0 - s.pad) * dpr) / dpr, Math.round((y - LABEL_H / 2) * dpr) / dpr, s.width / dpr, s.height / dpr);
      return true;
    };
    ctx.letterSpacing = '0px';
    const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const cardFont = `500 11.5px ${fonts.body}`;
    if (nbSet) {
      for (const i of [selected, ...adj[selected].map((a) => a[0])])
        if (visible(i)) put(cut(N[i].label, 34), sx(N[i].x) + radius(N[i]) + 4, sy(N[i].y), cardFont, colors.ink);
    } else {
      // noms de groupes à tous les zooms, dans la couleur du groupe, les plus grands d'abord ;
      // si la place est prise au cœur du groupe, on essaie juste au-dessus puis juste en dessous
      const gs = GR.filter((g) => g.size >= SMALL && (!linked || g.id === selGroup || linked.has(g.id)));
      for (const g of gs) {
        const x = sx(g.cx), y = sy(g.cy);
        if (x < -300 || x > W + 300 || y < -40 || y > H + 40) continue;
        const size = 11.5 + Math.min(4, Math.log2(g.size / SMALL)), font = `${fonts.labelWeight} ${size.toFixed(1)}px ${fonts.display}`;
        for (const dy of [0, -18, 18]) if (put(cut(groupName(g), 40), x, y + dy, font, groupText[g.id], 'center', fonts.labelHalo)) break;
      }
      if (zoom >= 2) {
        const maxLabels = Math.min(400, Math.round(10 * zoom * zoom));
        let n = 0;
        for (let k = order.length - 1; k >= 0 && n < maxLabels; k--) {
            const i = order[k];
          if (!visible(i) || (linked && alphaOf(i) < 0.3)) continue;
          const x = sx(N[i].x), y = sy(N[i].y);
          if (!on(x, y)) continue;
          if (put(cut(N[i].label, 34), x + radius(N[i]) + 4, y, cardFont, colors.ink)) n++;
        }
      }
    }
  }

  // L'écran : fond et grille (calque du dessous), puis, sur #map, les étiquettes (WebGL) ou la carte
  // dessinée en Canvas 2D, et enfin la sélection et le survol.
  function paint() {
    repaint = false; shownCam = { ...cam };
    gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gridCtx.fillStyle = colors.bg; gridCtx.fillRect(0, 0, W, H);
    graticule();
    screen.setTransform(dpr, 0, 0, dpr, 0, 0);
    screen.clearRect(0, 0, W, H);
    if (useGL) drawLabels(screen, cam, hl);
    else screen.drawImage(sceneLayer, 0, 0, W, H);
    if (selected >= 0) brackets(selected);
    if (hover >= 0 && hover !== selected) ring(hover, colors.ink, 1.5);
  }

  // WebGL : état (opacité, groupe, rareté, drapeaux de chaque carte ; liens mis en avant) et réglages
  const flat = (es) => { const f = new Float32Array(es.length * 3); es.forEach(([a, b, w], k) => { f[3 * k] = a; f[3 * k + 1] = b; f[3 * k + 2] = w; }); return f; };
  const posArray = () => { const f = new Float32Array(N.length * 4); N.forEach((n, i) => f.set([n.x || 0, n.y || 0, n.size, n.strength], i * 4)); return f; };
  function pushState() {
    const { linked, alphaOf } = hl, attr = new Float32Array(N.length * 4);
    N.forEach((n, i) => {
      const g = GR[n.group], zone = g.size >= SMALL && (!linked || g.id === selGroup || linked.has(g.id));
      attr[4 * i] = alphaOf(i); attr[4 * i + 1] = n.group; attr[4 * i + 2] = rarIdx(n.rarity);
      attr[4 * i + 3] = (visible(i) ? 1 : 0) | (zone ? 2 : 0);
    });
    const hiGroup = selGroup >= 0 ? interE.filter(([a, b]) => N[a].group === selGroup || N[b].group === selGroup) : [];
    const hiCard = selected >= 0 ? adj[selected].map(([j, w]) => [selected, j, w]) : [];
    glr.setState(attr, flat(hiGroup), flat(hiCard));
  }
  function glOptions() {
    const { nbSet, linked } = hl, fine = cam.k / kFit >= 2; // en zoomant, des courbes plus fines
    return {
      kMin, curve: CURVE, edge: glColors.edge, accent: glColors.accent, rar: glColors.rar,
      intraAlpha: nbSet || linked ? colors.edgeAlpha * 0.4 : colors.edgeAlpha, showInter: !nbSet && !linked,
      linkAlpha: colors.linkAlpha, zoneAlpha: nbSet ? colors.zoneAlpha * 0.5 : colors.zoneAlpha,
      intraSeg: fine ? 8 : 3, interSeg: fine ? 10 : 6,
      colorMode: colorMode === 'group' ? 0 : 1, ring: colorMode === 'group' ? 1 : 0, glow: colors.glow, glowMin: sMax * 0.5,
    };
  }

  // Grille fixée à la carte (elle suit zoom et déplacement), pas de 1, 2 ou 5 × 10ⁿ choisi pour garder
  // ~110 px entre deux lignes : un point à chaque croisement, une ligne sur cinq tracée avec une croix
  // aux croisements de ces lignes, et des graduations sur les bords de l'écran.
  function graticule() {
    const target = 110 / cam.k, p = Math.pow(10, Math.floor(Math.log10(target))), m = target / p;
    const step = p * (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10);
    const xs = [], ys = [];
    for (let v = Math.ceil((cam.x - W / 2 / cam.k) / step); v * step <= cam.x + W / 2 / cam.k; v++) xs.push([Math.round(sx(v * step)) + 0.5, v % 5 === 0]);
    for (let v = Math.ceil((cam.y - H / 2 / cam.k) / step); v * step <= cam.y + H / 2 / cam.k; v++) ys.push([Math.round(sy(v * step)) + 0.5, v % 5 === 0]);
    gridCtx.lineWidth = 1;
    gridCtx.strokeStyle = `rgba(${colors.grat},${colors.gratAlpha})`; gridCtx.beginPath();
    for (const [x, mj] of xs) if (mj) { gridCtx.moveTo(x, 0); gridCtx.lineTo(x, H); }
    for (const [y, mj] of ys) if (mj) { gridCtx.moveTo(0, y); gridCtx.lineTo(W, y); }
    gridCtx.stroke();
    gridCtx.fillStyle = `rgba(${colors.grat},${colors.gratAlpha * 2.2})`;
    for (const [x] of xs) for (const [y] of ys) gridCtx.fillRect(x - 1, y - 1, 1.5, 1.5);
    gridCtx.strokeStyle = `rgba(${colors.grat},${colors.gratAlpha * 4})`; gridCtx.beginPath();
    for (const [x, mx] of xs) for (const [y, my] of ys) if (mx && my) { gridCtx.moveTo(x - 5, y); gridCtx.lineTo(x + 5, y); gridCtx.moveTo(x, y - 5); gridCtx.lineTo(x, y + 5); }
    gridCtx.stroke();
    gridCtx.strokeStyle = `rgba(${colors.grat},${Math.min(1, colors.gratAlpha * 4)})`;
    gridCtx.beginPath();
    for (const [x, mj] of xs) { const t = mj ? 9 : 4; gridCtx.moveTo(x, 0); gridCtx.lineTo(x, t); gridCtx.moveTo(x, H); gridCtx.lineTo(x, H - t); }
    for (const [y, mj] of ys) { const t = mj ? 9 : 4; gridCtx.moveTo(0, y); gridCtx.lineTo(t, y); gridCtx.moveTo(W, y); gridCtx.lineTo(W - t, y); }
    gridCtx.stroke();
  }
  // carte choisie : crochets de visée et cercle pointillé ; sur grand écran, un pointillé la relie à sa fiche
  function brackets(i) {
    const n = N[i], x = sx(n.x), y = sy(n.y), d = radius(n) + 7, l = 5;
    screen.strokeStyle = colors.accent; screen.lineWidth = 1.5; screen.beginPath();
    for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { screen.moveTo(x + ax * d, y + ay * (d - l)); screen.lineTo(x + ax * d, y + ay * d); screen.lineTo(x + ax * (d - l), y + ay * d); }
    screen.stroke();
    screen.lineWidth = 1; screen.setLineDash([2, 3]); screen.globalAlpha = 0.45;
    screen.beginPath(); screen.arc(x, y, d + 6, 0, Math.PI * 2); screen.stroke();
    const det = $('detail');
    if (W >= NARROW && !det.hidden) {
      const px = det.getBoundingClientRect().left - canvas.getBoundingClientRect().left;
      if (px > x + d + 12) { screen.setLineDash([4, 4]); screen.beginPath(); screen.moveTo(x + d + 8, y); screen.lineTo(px, y); screen.stroke(); }
    }
    screen.setLineDash([]); screen.globalAlpha = 1;
  }
  function ring(i, color, width) {
    const n = N[i];
    screen.strokeStyle = color; screen.lineWidth = width;
    screen.beginPath(); screen.arc(sx(n.x), sy(n.y), radius(n) + 3, 0, Math.PI * 2); screen.stroke();
  }
  // À chaque image : la carte est redessinée entièrement, nette, dès que l'état ou la caméra a changé
  // (WebGL : quelques millisecondes) ; le survol seul ne refait que l'écran.
  function loop() {
    if (useGL && glr.lost()) { glFail('contexte perdu'); dirty = true; } // carte graphique perdue : Canvas 2D
    let redraw = cam.x !== shownCam.x || cam.y !== shownCam.y || cam.k !== shownCam.k;
    if (dirty) { dirty = false; hl = highlight(); if (useGL) try { pushState(); } catch (e) { glFail(e); } redraw = true; }
    if (redraw) {
      if (useGL) try { glr.render(cam, glOptions()); } catch (e) { glFail(e); }
      if (!useGL) { drawScene({ ...cam }, backLayer.getContext('2d'), hl); [sceneLayer, backLayer] = [backLayer, sceneLayer]; }
      repaint = true;
    }
    if (repaint) paint();
    requestAnimationFrame(loop);
  }

  // ---- navigation
  let drag = null, pinch = null, moved = false;
  const pointers = new Map();
  const clampK = (k) => Math.max(kFit * 0.5, Math.min(kFit * 400, k));
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    if (pointers.size === 2) { const [p, q] = [...pointers.values()]; pinch = { d: Math.hypot(p.x - q.x, p.y - q.y), k: cam.k }; }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [p, q] = [...pointers.values()];
      cam.k = clampK(pinch.k * Math.hypot(p.x - q.x, p.y - q.y) / pinch.d); moved = true; return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; canvas.classList.add('dragging'); }
      cam.x = drag.cx - dx / cam.k; cam.y = drag.cy - dy / cam.k; hideTip(); return;
    }
    const [px, py] = local(e), h = pick(px, py);
    if (h !== hover) { hover = h; repaint = true; canvas.classList.toggle('over', h >= 0); }
    h >= 0 ? showTip(h, e.clientX, e.clientY) : hideTip();
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !moved && pointers.size === 0) { const i = pick(...local(e)); i >= 0 ? selectCard(i) : clearSel(); }
    if (pointers.size === 0) drag = null;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('pointerleave', () => { hover = -1; hideTip(); repaint = true; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [px, py] = local(e), k = clampK(cam.k * Math.exp(-e.deltaY * 0.0015));
    const wx = (px - W / 2) / cam.k + cam.x, wy = (py - H / 2) / cam.k + cam.y;
    cam.k = k; cam.x = wx - (px - W / 2) / k; cam.y = wy - (py - H / 2) / k;
  }, { passive: false });

  function animateTo(x1, y1, k1, offset = true) {
    const x0 = cam.x, y0 = cam.y, k0 = cam.k, t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450;
    // la cible est décalée pour ne pas finir sous la fiche : à gauche sur grand écran, en haut sur téléphone
    const off = offset && W >= NARROW ? 180 / k1 : 0, offY = offset && W < NARROW ? H * 0.28 / k1 : 0;
    (function step(t) {
      const p = dur ? Math.min(1, (t - t0) / dur) : 1, e = 1 - Math.pow(1 - p, 3);
      cam.x = x0 + (x1 + off - x0) * e; cam.y = y0 + (y1 + offY - y0) * e; cam.k = k0 + (k1 - k0) * e;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  const flyTo = (n) => animateTo(n.x, n.y, Math.max(cam.k, kMin * 1.5));
  function flyToGroup(g) {
    let r = 0;
    for (const i of g.members) r = Math.max(r, Math.hypot(N[i].x - g.cx, N[i].y - g.cy));
    const avail = Math.min(W - (W >= NARROW ? 760 : 32), H * (W >= NARROW ? 0.9 : 0.45));
    animateTo(g.cx, g.cy, clampK(Math.min(kMin * 3, Math.max(60, avail) / (2 * r + 1))));
  }

  // ---- panneau de détail
  const tip = $('tip');
  function showTip(i, x, y) {
    const n = N[i];
    tip.innerHTML = '<b></b><span></span>';
    tip.querySelector('b').textContent = n.label;
    tip.querySelector('span').textContent = `${n.rarity} · ${fmt.format(n.buyers)} acheteurs · ${groupName(GR[n.group])}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(x + 14, innerWidth - r.width - 8) + 'px';
    tip.style.top = Math.min(y + 14, innerHeight - r.height - 8) + 'px';
  }
  function hideTip() { tip.hidden = true; }
  // étiquette de rareté (couleurs dans map.css, .rt.L … .rt.C)
  function rarTag(r, big) { const el = document.createElement('span'); setRar(el, r, big); return el; }
  function setRar(el, r, big) { el.className = 'rt ' + r + (big ? ' lg' : ''); el.textContent = r; }
  function setDetailGroup(gid) { detailGroup = gid; $('detail').style.setProperty('--gcol', groupCol[gid]); }
  // ligne de liste : pastille, texte, [force en 5 cases], valeur
  function listItem(lead, text, meta, onClick, level) {
    const li = document.createElement('li'), t = document.createElement('span'), m = document.createElement('span');
    t.className = 't'; t.textContent = text; t.title = text; m.className = 'm'; m.textContent = meta;
    const sq = document.createElement('span');
    if (level != null) { sq.className = 'sq'; sq.setAttribute('aria-hidden', 'true'); for (let k = 0; k < 5; k++) sq.append(Object.assign(document.createElement('i'), { className: k < level ? 'on' : '' })); }
    li.append(lead, t, sq, m); li.addEventListener('click', onClick);
    return li;
  }
  function emptyItem(ul, text) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = text; ul.append(li); }
  const gdot = (gid) => { const d = document.createElement('span'); d.className = 'gdot'; d.style.background = groupCol[gid]; return d; };

  // symbole des wikibidous, la monnaie du jeu : un W dans un cercle
  const COIN = '<svg class="coin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.4"/>'
    + '<path transform="translate(12 12.3) scale(.74) translate(-12 -12)" d="M4.4 7.3h2.3l2.6 10.1h-0.9z M13.8 7.3h1l-5.5 10.1h-0.8z '
    + 'M9.4 7.3h2.3l3.7 10.1h-0.9z M18.8 7.3h1l-4.4 10.1h-0.8z M3.3 6.6h4.5v0.8h-4.5z M8.4 6.6h4.2v0.8h-4.2z M13 6.6h2.6v0.8h-2.6z M18 6.6h2.6v0.8h-2.6z"/></svg>';

  function clearSel() { selected = -1; selGroup = -1; $('detail').hidden = true; sheetClosed(); setHash(''); dirty = true; }

  // ---- fiche : panneau à droite sur grand écran ; sur téléphone, tiroir à deux crans (milieu : à
  // l'ouverture, haut : plein écran) qu'on fait glisser. Toute la fiche défile d'un bloc ; tant
  // qu'elle n'est pas en haut, glisser vers le haut la monte d'abord, et glisser vers le bas la
  // redescend quand son contenu est revenu au début. Relâchée vers le bas avec son haut sous la
  // moitié de l'écran, elle se ferme.
  const sheet = $('detail'), phone = matchMedia(`(max-width: ${NARROW}px)`);
  let sheetY = 0, sd = null, closing = false;
  const scroller = () => sheet.querySelector(':scope > div:not([hidden])');
  // crans en px depuis le haut de la zone carte ; le milieu place le haut de la fiche à 45 % de
  // l'écran, et au moins 40 px au-dessus de la ligne de fermeture (50 %) : un simple toucher ou un
  // petit glissement ne la ferment jamais, même sur un petit écran
  function snaps() {
    const h = sheet.parentElement.clientHeight, top = sheet.parentElement.getBoundingClientRect().top;
    return { full: 0, half: Math.max(0, Math.round(Math.min(innerHeight * 0.45, innerHeight * 0.5 - 40) - top)), closeAt: innerHeight * 0.5 - top, h };
  }
  function setSheet(y, animate) {
    sheetY = y; sheet.style.transition = animate ? 'transform 0.28s cubic-bezier(.2,.8,.2,1)' : 'none';
    sheet.style.transform = `translateY(${y}px)`;
    // le navigateur ne fait défiler lui-même la fiche qu'en haut (voir touch-action dans map.css) :
    // ailleurs, c'est le tiroir qui suit le doigt, sans que le navigateur ne ralentisse les gestes
    sheet.classList.toggle('sheet-full', y <= 0.5);
  }
  function showDetail(id) {
    const wasOpen = !sheet.hidden && !closing; closing = false;
    $('detail-card').hidden = id !== 'detail-card'; $('detail-group').hidden = id !== 'detail-group'; sheet.hidden = false;
    scroller().scrollTop = 0;
    if (!phone.matches) { sheet.style.transform = ''; sheet.style.transition = ''; return; }
    document.querySelector('.app').classList.add('sheet-open'); // pied de page masqué : plus de place
    if (!wasOpen) { const s = snaps(); setSheet(s.h, false); requestAnimationFrame(() => requestAnimationFrame(() => setSheet(s.half, true))); }
  }
  function sheetClosed() { document.querySelector('.app').classList.remove('sheet-open'); sheet.style.transform = ''; sheet.style.transition = ''; }
  sheet.addEventListener('touchstart', (e) => {
    if (!phone.matches || e.touches.length > 1) return;
    const y = e.touches[0].clientY;
    // geste parti de l'en-tête (poignée, « Fiche carte », Lien, ✕) : il déplace toujours le tiroir
    const head = y - sheet.getBoundingClientRect().top < 52;
    sd = { y0: y, s0: sheetY, mode: null, head, pts: [[y, performance.now()]] };
  }, { passive: true });
  // vitesse du doigt (px/ms, positive vers le bas) sur les 100 dernières millisecondes du geste
  const speed = (pts) => {
    const last = pts[pts.length - 1], first = pts.find((q) => last[1] - q[1] <= 100) || last;
    return last[1] > first[1] ? (last[0] - first[0]) / (last[1] - first[1]) : 0;
  };
  sheet.addEventListener('touchmove', (e) => {
    if (!sd) return;
    const y = e.touches[0].clientY, dy = y - sd.y0, s = snaps();
    if (!sd.mode) {
      if (Math.abs(dy) < 2) return;
      // depuis l'en-tête : on déplace toujours le tiroir ; ailleurs, en haut, le contenu défile,
      // sauf si l'on tire vers le bas depuis le début de la fiche
      sd.mode = !sd.head && sheetY <= s.full + 1 && (dy < 0 || scroller().scrollTop > 0) ? 'scroll' : 'sheet';
    }
    if (sd.mode !== 'sheet') return;
    e.preventDefault();
    sd.pts.push([y, performance.now()]); if (sd.pts.length > 20) sd.pts.shift();
    setSheet(Math.min(s.h - 56, Math.max(s.full, sd.s0 + dy)), false);
  }, { passive: false });
  const endDrag = () => {
    if (!sd) return;
    const d = sd; sd = null;
    if (d.mode !== 'sheet') return;
    const s = snaps(), v = speed(d.pts);
    // glisse hors de l'écran, puis se ferme (sauf si une autre fiche a été ouverte entre-temps)
    const close = () => { closing = true; setSheet(s.h, true); setTimeout(() => { if (closing) clearSel(); closing = false; }, 220); };
    if (sheetY > d.s0 && sheetY > s.closeAt) return close(); // relâchée vers le bas sous la moitié de l'écran : fermée
    // sinon le cran le plus proche ; un geste net (> 0,3 px/ms) choisit le cran dans son sens
    let target = Math.abs(sheetY - s.full) < Math.abs(sheetY - s.half) ? s.full : s.half;
    if (Math.abs(v) > 0.3) target = v < 0 ? s.full : s.half;
    setSheet(target, true);
  };
  sheet.addEventListener('touchend', endDrag);
  sheet.addEventListener('touchcancel', endDrag);
  // rotation, clavier, passage en grand écran : on se recale sur le cran le plus proche
  new ResizeObserver(() => {
    if (sheet.hidden || closing) return;
    if (!phone.matches) { sheetClosed(); return; }
    document.querySelector('.app').classList.add('sheet-open');
    const s = snaps();
    setSheet(Math.abs(sheetY - s.full) < Math.abs(sheetY - s.half) ? s.full : s.half, false);
  }).observe($('stage'));
  function selectCard(i, fly) {
    selected = i; selGroup = -1; dirty = true;
    const n = N[i], g = GR[n.group];
    setDetailGroup(g.id);
    setRar($('d-rar'), n.rarity, true);
    $('d-title').textContent = n.label;
    $('d-cat').textContent = n.category || 'Sans description Wikidata';
    $('d-buyers').textContent = fmt.format(n.buyers);
    $('d-sales').textContent = fmt.format(n.sales || 0);
    if (n.price == null) { $('d-price').textContent = '–'; $('d-price').removeAttribute('aria-label'); }
    else { $('d-price').innerHTML = fmt.format(Math.round(n.price)) + COIN; $('d-price').setAttribute('aria-label', `${fmt.format(Math.round(n.price))} wikibidous`); }
    $('d-wiki').href = 'https://fr.wikipedia.org/wiki/' + encodeURIComponent(n.label.replace(/ /g, '_'));
    const gb = $('d-group');
    gb.querySelector('.gdot').style.background = groupCol[g.id];
    gb.querySelector('.t').textContent = groupName(g);
    gb.querySelector('.m').textContent = `${fmt.format(g.size)} cartes`;
    gb.setAttribute('aria-label', `Voir le groupe ${groupName(g)}, ${fmt.format(g.size)} cartes`);
    gb.onclick = () => selectGroup(g.id, true);
    // voisines, de la plus partagée à la moins partagée (acheteurs en commun, le nombre affiché ;
    // à égalité, la force du lien) ; rendu en 5 cases, relatif à la plus partagée
    const ul = $('nb'); ul.textContent = '';
    const nb = adj[i].slice().sort((a, b) => b[2] - a[2] || b[1] - a[1]);
    const coMax = Math.max(1, ...nb.map((a) => a[2]));
    for (const [j, , co] of nb) ul.append(listItem(rarTag(N[j].rarity), N[j].label, `${co} en commun`, () => selectCard(j, true), Math.max(1, Math.round(co / coMax * 5))));
    if (!adj[i].length) emptyItem(ul, 'Aucun lien assez fort.');
    $('nb-title').textContent = 'Achetées par les mêmes joueurs';
    $('nb-count').textContent = adj[i].length || '';
    showDetail('detail-card');
    setHash('carte=' + slug(n.label));
    if (fly) flyTo(n);
  }
  function selectGroup(gid, fly) {
    selected = -1; selGroup = gid; dirty = true;
    // groupes liés, du plus relié au moins relié : les clés de g.links sont des numéros de groupe,
    // que JavaScript range toujours par ordre croissant, d'où le tri explicite
    const g = GR[gid], links = Object.entries(g.links).sort((a, b) => b[1] - a[1]);
    setDetailGroup(gid);
    $('g-dot').style.background = groupCol[gid];
    $('g-kind').textContent = g.size < SMALL ? 'Fiche petit groupe' : 'Fiche groupe';
    $('g-title').textContent = groupName(g);
    $('g-sub').textContent = 'Cartes phares : ' + g.top.slice(0, 3).join(', ');
    $('g-size').textContent = fmt.format(g.size);
    $('g-out').textContent = fmt.format(links.reduce((t, [, v]) => t + v, 0));
    $('g-nlinked').textContent = fmt.format(links.length);
    const cnt = {}; g.members.forEach((i) => { cnt[N[i].rarity] = (cnt[N[i].rarity] || 0) + 1; });
    const bar = $('g-rbar'); bar.textContent = '';
    for (const r of RARITIES) if (cnt[r]) {
      const s = document.createElement('span'); s.style.flex = cnt[r]; s.style.background = colors[r]; s.title = `${r} : ${cnt[r]}`; bar.append(s);
    }
    const ul = $('g-linked'); ul.textContent = '';
    const vMax = Math.max(1, ...links.map(([, v]) => v));
    for (const [o, v] of links.slice(0, 12)) ul.append(listItem(gdot(+o), groupName(GR[o]), fmt.format(v), () => selectGroup(+o, true), Math.max(1, Math.round(v / vMax * 5))));
    if (!links.length) emptyItem(ul, 'Aucun : ce groupe est isolé.');
    // cartes les plus centrales : centralité (somme des forces de liens) en 5 cases, relative à la
    // première ; le nombre d'acheteurs passe en infobulle
    const uc = $('g-cards'); uc.textContent = '';
    const central = g.members.slice().sort((a, b) => N[b].strength - N[a].strength).slice(0, 25);
    const stMax = Math.max(1e-9, ...central.map((i) => N[i].strength));
    for (const i of central) {
      const li = listItem(rarTag(N[i].rarity), N[i].label, '', () => selectCard(i, true), Math.max(1, Math.round(N[i].strength / stMax * 5)));
      li.title = `${N[i].label} · ${fmt.format(N[i].buyers)} acheteurs`; uc.append(li);
    }
    showDetail('detail-group');
    setHash('groupe=' + (g.name ? slug(g.name) : g.id));
    if (fly) flyToGroup(g);
  }
  $('close').addEventListener('click', clearSel);

  // ---- liens partageables : #carte=Titre_de_la_carte ou #groupe=Nom_du_groupe (groupe sans nom :
  // son numéro, qui peut changer d'un calcul à l'autre)
  const slug = (s) => encodeURIComponent(s.replace(/ /g, '_'));
  function setHash(h) {
    if (location.hash.slice(1) === h) return;
    try { history.replaceState(null, '', location.pathname + location.search + (h ? '#' + h : '')); } catch (e) { /* page encadrée */ }
  }
  function fromHash() {
    const m = /^#(carte|groupe)=(.+)$/.exec(location.hash);
    if (!m || !N) return;
    let name; try { name = decodeURIComponent(m[2]).replace(/_/g, ' '); } catch (e) { return; }
    if (m[1] === 'carte') {
      let i = N.findIndex((n) => n.label === name);
      if (i < 0) i = N.findIndex((n) => n.norm === norm(name));
      if (i >= 0) { hidden.delete(N[i].rarity); syncLegend(); selectCard(i, true); }
    } else {
      const g = GR.find((x) => x.name === name) || GR.find((x) => x.name && norm(x.name) === norm(name)) || (/^\d+$/.test(name) ? GR[+name] : null);
      if (g) selectGroup(g.id, true);
    }
  }
  addEventListener('hashchange', fromHash);
  // bouton « Copier le lien » de la fiche
  $('share').addEventListener('click', async () => {
    const b = $('share'), label = b.querySelector('.t');
    try { await navigator.clipboard.writeText(location.href); label.textContent = 'Lien copié'; }
    catch (e) { label.textContent = 'Copiez l’adresse'; }
    setTimeout(() => { label.textContent = 'Lien'; }, 1800);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.activeElement !== $('q') && !document.querySelector('dialog[open]')) clearSel(); });
  $('brand').addEventListener('click', (e) => { e.preventDefault(); if (!N) return; clearSel(); const v = fitView(); animateTo(v.x, v.y, v.k, false); });

  // ---- encarts
  for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => $(b.dataset.open).showModal());
  for (const d of document.querySelectorAll('dialog')) {
    d.querySelector('.dlg-close').addEventListener('click', () => d.close());
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // clic sur le fond
  }

  // ---- recherche
  const q = $('q'), sugg = $('sugg');
  let matches = [], active = 0;
  // suggestions : groupes nommés d'abord (3 au plus), puis cartes ; { g: id } ou { c: index }
  function renderSugg() {
    sugg.textContent = '';
    matches.forEach((m, k) => {
      const li = document.createElement('li'), t = document.createElement('span');
      li.setAttribute('role', 'option'); li.setAttribute('aria-selected', String(k === active));
      t.className = 't';
      if (m.g != null) {
        const g = GR[m.g], n = document.createElement('span');
        t.textContent = groupName(g); n.className = 'n'; n.textContent = `groupe · ${fmt.format(g.size)} cartes`;
        li.append(gdot(g.id), t, n);
      } else {
        t.textContent = N[m.c].label; li.append(rarTag(N[m.c].rarity), t);
      }
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(m); });
      sugg.append(li);
    });
    sugg.hidden = !matches.length; q.setAttribute('aria-expanded', String(!!matches.length));
  }
  function choose(m) {
    matches = []; renderSugg(); q.blur();
    if (m.g != null) { q.value = groupName(GR[m.g]); selectGroup(m.g, true); return; }
    q.value = N[m.c].label; hidden.delete(N[m.c].rarity); syncLegend(); selectCard(m.c, true);
  }
  q.addEventListener('input', () => {
    if (!N) return;
    const s = norm(q.value.trim());
    active = 0;
    if (s.length < 2) { matches = []; return renderSugg(); }
    const groups = GR.filter((g) => g.name && norm(g.name).includes(s)).sort((a, b) => b.size - a.size).slice(0, 3).map((g) => ({ g: g.id }));
    const starts = [], contains = [];
    for (let k = order.length - 1; k >= 0 && starts.length < 8; k--) {
      const i = order[k], l = N[i].norm;
      if (l.startsWith(s)) starts.push(i); else if (l.includes(s)) contains.push(i);
    }
    matches = groups.concat(starts.concat(contains).map((c) => ({ c }))).slice(0, 9);
    renderSugg();
  });
  q.addEventListener('keydown', (e) => {
    if (!matches.length) return;
    if (e.key === 'ArrowDown') { active = (active + 1) % matches.length; renderSugg(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = (active - 1 + matches.length) % matches.length; renderSugg(); e.preventDefault(); }
    if (e.key === 'Enter') { choose(matches[active]); e.preventDefault(); }
    if (e.key === 'Escape') { matches = []; renderSugg(); }
  });
  q.addEventListener('blur', () => { matches = []; renderSugg(); });

  // ---- réglages
  // résumé affiché quand les filtres sont repliés, ex. « Groupe · 6/6 raretés »
  function syncSummary() {
    const total = $('legend').children.length, shown = total - [...$('legend').children].filter((b) => hidden.has(b.dataset.r)).length;
    $('rar-count').textContent = `${shown} / ${total}`;
    $('ctl-sum').textContent = `${colorMode === 'group' ? 'Groupe' : 'Rareté'} · ${shown}/${total} raretés`;
  }
  function syncLegend() { for (const b of $('legend').children) b.setAttribute('aria-pressed', String(!hidden.has(b.dataset.r))); syncSummary(); dirty = true; }
  function setColorMode(m) {
    colorMode = m;
    for (const b of $('color-mode').children) b.setAttribute('aria-pressed', String(b.dataset.v === m));
    $('color-hint').textContent = m === 'group'
      ? 'Une couleur par groupe (gris : moins de 5 cartes). En zoomant, l’anneau autour du point donne la rareté.'
      : 'Une couleur par rareté.';
    syncSummary();
    dirty = true;
  }
  for (const b of $('color-mode').children) b.addEventListener('click', () => setColorMode(b.dataset.v));
  function setCollapsed(c) {
    $('controls').classList.toggle('collapsed', c);
    const t = $('ctl-toggle');
    t.textContent = c ? '+' : '−'; t.setAttribute('aria-expanded', String(!c)); t.setAttribute('aria-label', c ? 'Déplier les filtres' : 'Replier les filtres');
  }
  $('ctl-toggle').addEventListener('click', () => setCollapsed(!$('controls').classList.contains('collapsed')));
  setCollapsed(innerWidth < NARROW); // sur téléphone, les filtres démarrent repliés

  // ---- zoom par boutons, autour du centre de l'écran
  function zoomBy(f) { if (N) animateTo(cam.x, cam.y, clampK(cam.k * f), false); }
  $('zoom-in').addEventListener('click', () => zoomBy(1.8));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.8));
  $('zoom-fit').addEventListener('click', () => { if (!N) return; const v = fitView(); animateTo(v.x, v.y, v.k, false); });

  // ---- thème clair / sombre : suit le système, jusqu'à ce qu'on choisisse (retenu par le navigateur)
  const THEME_KEY = 'wikimap-theme';
  const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
  function syncThemeBtn() {
    const b = $('theme'), d = isDark();
    b.classList.toggle('is-dark', d); b.setAttribute('aria-label', d ? 'Passer en thème clair' : 'Passer en thème sombre'); b.title = b.getAttribute('aria-label');
  }
  try { const t = localStorage.getItem(THEME_KEY); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { /* stockage indisponible */ }
  $('theme').addEventListener('click', () => {
    const t = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = t; // l'observateur relit les couleurs
    try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* stockage indisponible */ }
  });

  // ---- pied de page : blocs de chiffres
  function footer(g) {
    const d = g.data || {}, big = GR.filter((x) => x.size >= SMALL).length;
    const day = (s) => (s ? new Date(s + 'T12:00:00') : null);
    const d0 = day(d.first_sale), d1 = day(d.last_sale);
    const period = d0 && d1 ? `${fmtDay.format(d0).replace('/', '.')} → ${fmtDay.format(d1).replace('/', '.')}.${String(d1.getFullYear()).slice(2)}` : '?';
    const stats = [
      [fmt.format(N.length), 'Cartes'], [big, 'Groupes'], [compact(d.purchases || 0), 'Achats'],
      [fmt.format(d.collectors || 0), 'Collectionneurs'], [period, 'Période des ventes'],
    ];
    const box = $('foot-data'); box.textContent = '';
    for (const [v, l] of stats) {
      const s = document.createElement('div'), b = document.createElement('b'), c = document.createElement('span');
      s.className = 'stat'; b.textContent = v; c.className = 'cap'; c.textContent = l; s.append(b, c); box.append(s);
    }
    if (d0 && d1) box.lastChild.title = `Ventes du ${fmtDate.format(d0)} au ${fmtDate.format(d1)}`;
    // compteur de visites (worker/index.js) : masqué tant qu'il n'a pas répondu, et s'il ne répond pas
    const v = document.createElement('div'), vb = document.createElement('b'), vc = document.createElement('span');
    v.className = 'stat'; v.id = 'stat-visits'; v.hidden = true; vc.className = 'cap'; vc.textContent = 'Visites'; v.append(vb, vc); box.append(v);
    countVisit();
  }
  // une visite par session de navigateur (un rechargement ne compte pas) ; ni cookie ni identifiant
  function countVisit() {
    let counted = false;
    try { counted = sessionStorage.getItem('wikimap-visit') === '1'; } catch (e) { /* stockage indisponible */ }
    fetch('api/visit', { method: counted ? 'GET' : 'POST' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        try { sessionStorage.setItem('wikimap-visit', '1'); } catch (e) { /* stockage indisponible */ }
        const el = $('stat-visits'); el.querySelector('b').textContent = fmt.format(d.visits); el.hidden = false;
      })
      .catch(() => {}); // pas de compteur (aperçu, serveur local) : le bloc reste masqué
  }

  // ---- chargement
  readColors(); resize(); setColorMode('group');
  // police du canvas : chargée explicitement, puis on redessine
  if (document.fonts) Promise.all([`${fonts.labelWeight} 14px ${fonts.display}`, `500 11.5px ${fonts.body}`].map((f) => document.fonts.load(f)))
    .then(() => { dirty = true; }, () => {});
  // ?carte=50 charge data/graph-50.json (autre seuil d'acheteurs) ; sans paramètre, data/graph.json
  const carte = (new URLSearchParams(location.search).get('carte') || '').match(/^\d+$/);
  fetch(carte ? `data/graph-${carte[0]}.json` : 'data/graph.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((g) => {
    N = g.nodes; E = g.edges; GR = g.groups; layouts = g.layouts || {};
    const names = Object.keys(layouts);
    if (!names.length) throw new Error('aucune disposition calculée');
    N.forEach((n) => { n.norm = norm(n.label); });
    interE = E.filter(([a, b]) => N[a].group !== N[b].group);
    adj = N.map(() => []);
    for (const [a, b, w, co] of E) { adj[a].push([b, w, co]); adj[b].push([a, w, co]); }
    adj.forEach((l) => l.sort((p, q) => q[1] - p[1]));
    order = N.map((_, i) => i).sort((a, b) => N[a].strength - N[b].strength); // faibles d'abord, centrales dessus
    sMax = N[order[Math.floor(order.length * 0.9)]].strength;
    kMin = 1.4 / N.map((n) => n.size).sort((a, b) => a - b)[N.length >> 1];
    if (useGL) try { glr.setGraph(N.length, posArray(), Float32Array.from(order), flat(E.filter(([a, b]) => N[a].group === N[b].group)), flat(interE)); } catch (e) { glFail(e); }
    readColors();

    const counts = {};
    N.forEach((n) => { counts[n.rarity] = (counts[n.rarity] || 0) + 1; });
    // une ligne par rareté : étiquette, part des cartes (barre, relative à la plus nombreuse), nombre, case
    const cMax = Math.max(...Object.values(counts));
    for (const r of RARITIES) {
      if (!counts[r]) continue;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rrow'; b.dataset.r = r; b.setAttribute('aria-pressed', 'true');
      b.setAttribute('aria-label', `${r} : ${fmt.format(counts[r])} cartes`);
      b.innerHTML = '<span class="bar"><i></i></span><span class="n"></span><span class="box"></span>';
      b.prepend(rarTag(r));
      b.querySelector('.bar i').style.width = Math.max(2, Math.round(counts[r] / cMax * 100)) + '%';
      b.querySelector('.n').textContent = fmt.format(counts[r]);
      b.addEventListener('click', () => { hidden.has(r) ? hidden.delete(r) : hidden.add(r); syncLegend(); });
      $('legend').append(b);
    }
    syncSummary();
    if (names.length > 1) {
      for (const name of names) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.v = name; b.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        b.addEventListener('click', () => setLayout(name));
        $('layout-mode').append(b);
      }
      $('layout-box').hidden = false;
    }
    footer(g);
    setLayout(names[0]);
    $('status').hidden = true; requestAnimationFrame(loop);
    fromHash(); // lien partagé : ouvre directement la carte ou le groupe
  }).catch((err) => {
    $('status').textContent = `La carte n'a pas pu être chargée (${err.message}).`;
    $('foot-data').textContent = 'Données indisponibles';
  });
})();
