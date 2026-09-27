/**
 * layout.mjs — positions des cartes (ForceAtlas2) pour la map.
 *
 *   node pipeline/layout.mjs [--iterations 1000] [--scaling 2] [--gravity 25] [--spread 3] [--group-pull 3]
 *                       [--name principale]
 *   (depuis la racine, après pipeline/graph.py ; npm install dans pipeline/)
 *
 * Lit site/data/graph.json, y ajoute la disposition sous layouts[--name] (positions à plat
 * [x0, y0, x1, y1, …]) et le rayon de chaque carte (size), et le réécrit. Plusieurs dispositions
 * peuvent coexister (la visionneuse passe de l'une à l'autre). LinLog + Barnes-Hut : les groupes de
 * cartes co-achetées se séparent nettement ; graine fixe, disposition reproductible.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const ITER = opt('--iterations', 1000);
const SCALING = opt('--scaling', 2), GRAVITY = opt('--gravity', 25); // gravité 25 (« très serrée ») : carte 4,6 fois plus serrée qu'à 1, groupes aussi nets
const NAME = argv.includes('--name') ? argv[argv.indexOf('--name') + 1] : 'principale';
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'data', 'graph.json');

const g = JSON.parse(readFileSync(FILE, 'utf8'));
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

// Départ : on place d'abord les groupes entre eux (un nœud par groupe, liens = nombre de liens
// entre leurs cartes), puis chaque carte démarre sur son groupe. Les groupes liés partent ainsi côte
// à côte ; sans ça, l'attraction de groupe (plus bas) les figerait là où le hasard les a posés.
const gg = new Graph({ type: 'undirected' });
g.groups.forEach((grp) => gg.addNode(grp.id, { x: rand() * 1000, y: rand() * 1000, size: 1 + Math.sqrt(grp.size) }));
g.groups.forEach((grp) => Object.entries(grp.links).forEach(([o, w]) => {
  if (grp.id < +o) gg.addEdge(grp.id, +o, { weight: w });
}));
forceAtlas2.assign(gg, { iterations: 800, settings: { ...forceAtlas2.inferSettings(gg), linLogMode: true, strongGravityMode: false, gravity: 1 }, getEdgeWeight: 'weight' });
const gx = g.groups.map((grp) => gg.getNodeAttribute(grp.id, 'x')), gy = g.groups.map((grp) => gg.getNodeAttribute(grp.id, 'y'));
const span = Math.max(Math.max(...gx) - Math.min(...gx), Math.max(...gy) - Math.min(...gy)) || 1;
const start = g.groups.map((_, k) => [(gx[k] - Math.min(...gx)) / span * 1000, (gy[k] - Math.min(...gy)) / span * 1000]);

const graph = new Graph({ type: 'undirected' });
g.nodes.forEach((n, i) => {
  const [cx, cy] = start[n.group];
  graph.addNode(i, { x: cx + (rand() - 0.5) * 40, y: cy + (rand() - 0.5) * 40, size: 1 + 2 * Math.sqrt(n.strength) });
});
// poids ramenés à une moyenne de 1 : les cosinus (médiane ~0,14) rendraient l'attraction trop
// faible face à la répulsion, et toutes les cartes s'étaleraient en un disque uniforme
const meanS = g.edges.reduce((t, e) => t + e[2], 0) / g.edges.length;
for (const [a, b, s] of g.edges) graph.addEdge(a, b, { weight: s / meanS });

// Attraction de groupe. Placées d'après leurs seuls liens, les cartes d'un groupe peuvent se couper
// en morceaux éloignés (joueurs NBA en haut, équipes en bas) : chaque morceau suit ses liens vers
// d'autres groupes. Un point invisible par groupe (5 cartes ou plus), relié à toutes ses cartes
// avec le poids --group-pull (1 = un lien moyen ; 3 : 9 groupes nommés sur 130 restent éclatés, contre 49 sans), les rassemble ; il est retiré avant l'écriture.
const PULL = opt('--group-pull', 3);
const hubs = [];
if (PULL > 0) g.groups.forEach((grp) => {
  if (grp.size < 5) return;
  const h = `h${grp.id}`;
  graph.addNode(h, { x: start[grp.id][0], y: start[grp.id][1], size: 1 });
  hubs.push(h);
});
g.nodes.forEach((n, i) => { if (graph.hasNode(`h${n.group}`)) graph.addEdge(i, `h${n.group}`, { weight: PULL }); });

const t0 = Date.now();
// pas d'inferSettings : au-delà de quelques milliers de nœuds il active strongGravityMode (tout est
// tassé en disque) et slowDown ~10 (rien ne converge en 1 000 itérations)
const settings = { linLogMode: true, barnesHutOptimize: true, barnesHutTheta: 0.5, strongGravityMode: false,
  slowDown: 1, edgeWeightInfluence: 1, gravity: GRAVITY, scalingRatio: SCALING };
const STEP = 100;
for (let done = 0; done < ITER; done += STEP) {
  forceAtlas2.assign(graph, { iterations: Math.min(STEP, ITER - done), settings, getEdgeWeight: 'weight' });
  console.log(`${Math.min(done + STEP, ITER)}/${ITER} itérations · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
hubs.forEach((h) => graph.dropNode(h));

// LinLog repousse très loin les petits groupes sans lien avec le reste : au-delà du rayon qui
// contient 90 % des cartes, les distances au centre sont compressées (logarithme), l'ordre est gardé
const pts = g.nodes.map((_, i) => graph.getNodeAttributes(i));
const med = (v) => v.slice().sort((a, b) => a - b)[v.length >> 1];
const cx = med(pts.map((p) => p.x)), cy = med(pts.map((p) => p.y));
const radii = pts.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
const R = radii[Math.floor(radii.length * 0.9)];
pts.forEach((p) => {
  const dx = p.x - cx, dy = p.y - cy, r = Math.hypot(dx, dy);
  const k = r > R ? (R * (1 + 0.5 * Math.log(r / R))) / r : 1;
  p.x = dx * k; p.y = dy * k;
});

// Anti-chevauchement. La taille (rayon) de chaque carte est dans l'unité des positions, et la
// visionneuse la multiplie par le zoom : si les cercles ne se touchent pas ici, ils ne se touchent
// à aucun zoom. On met d'abord la carte à l'échelle des cercles (distance médiane au plus proche
// voisin = SPREAD x rayon médian), puis noverlap écarte ceux qui se chevauchent encore.
const SPREAD = opt('--spread', 3);
function cells(cell) {
  const m = new Map();
  pts.forEach((p, i) => { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (m.get(k) || m.set(k, []).get(k)).push(i); });
  return m;
}
function scan(cell, fn) { // appelle fn(i, j, distance) pour les paires de cellules voisines
  const m = cells(cell);
  pts.forEach((p, i) => {
    const gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++)
      for (const j of m.get(`${gx + a},${gy + b}`) || []) if (j > i) fn(i, j, Math.hypot(p.x - pts[j].x, p.y - pts[j].y));
  });
}
const maxSize = Math.max(...pts.map((p) => p.size));
const overlaps = () => { let n = 0; scan(2 * maxSize, (i, j, d) => { if (d < pts[i].size + pts[j].size) n++; }); return n; };
const nn = pts.map(() => Infinity);
scan(R / 50, (i, j, d) => { nn[i] = Math.min(nn[i], d); nn[j] = Math.min(nn[j], d); });
const scale = (SPREAD * med(pts.map((p) => p.size))) / med(nn.filter(Number.isFinite));
pts.forEach((p, i) => graph.mergeNodeAttributes(i, { x: p.x * scale, y: p.y * scale }));
pts.forEach((p, i) => Object.assign(p, graph.getNodeAttributes(i)));
console.log(`échelle x${scale.toFixed(4)} · ${overlaps().toLocaleString('fr')} paires de cercles qui se chevauchent`);
noverlap.assign(graph, { maxIterations: 500, settings: { margin: 1, ratio: 1, expansion: 1.05, speed: 3 } });
pts.forEach((p, i) => Object.assign(p, graph.getNodeAttributes(i)));
console.log(`après noverlap : ${overlaps().toLocaleString('fr')} paires`);

g.nodes.forEach((n, i) => { n.size = Math.round(pts[i].size * 100) / 100; });
g.layouts = g.layouts || {};
g.layouts[NAME] = { iterations: ITER, spread: SPREAD, groupPull: PULL, ...settings,
  xy: pts.flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]) };
writeFileSync(FILE, JSON.stringify(g));
console.log(`positions écrites dans ${FILE} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
