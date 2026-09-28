"""graph.py — graphe carte <-> carte des co-achats, pour la map.

    python pipeline/graph.py [--min-buyers 50] [--min-co 10] [--top-k 10] [--out graph.json]
                             [--split 0.5] [--split-min 8] [--names names.json]

    Ancienne carte (archive, site/data/graph-75.json) : --min-buyers 75 --split 0 --names names-75.json
                                                         --out graph-75.json
                             (depuis la racine, après buyers.py)

Entrée  : data/purchases.parquet, $WIKIMAP_INPUT/cards.parquet (catalogue des cartes)
Sortie  : site/data/<--out> { nodes, edges: [[i, j, poids, co_acheteurs], ...], groups, data }
          (site/ = ce qui est publié ; les positions sont ajoutées ensuite par layout.mjs)

  - nœuds : cartes achetées par au moins --min-buyers acheteurs distincts (acheteurs retenus par
    buyers.py ; plusieurs achats de la même carte par un joueur comptent une fois) ;
  - lien i-j : cosinus entre les ensembles d'acheteurs, chaque acheteur pesant 1 / (k - 1) où k est
    son nombre de cartes du graphe : un joueur qui achète de tout relie tout, son poids par lien
    doit baisser d'autant (allocation de ressources) ;
  - on garde les liens portés par au moins --min-co acheteurs communs (bruit, et aucun lien ne
    renvoie à une poignée de joueurs), puis les --top-k meilleurs voisins de chaque carte ;
  - les cartes restées sans lien sont retirées ; strength = somme des poids de ses liens (taille
    du point sur la map : carte centrale dans son groupe ou faiblement rattachée) ;
  - groupes : Louvain pondéré (graine fixe, --resolution) ; pour chaque groupe, ses cartes les plus
    centrales, le nombre de liens vers chacun des autres groupes et son nom (names.py / names.json) ;
    avec --split, les groupes composites sont redécoupés (voir split()) et gardent leur famille.
"""
import argparse, duckdb, json, os, pathlib, time
import networkx as nx
import numpy as np
from scipy import sparse
from names import apply_names

ap = argparse.ArgumentParser()
ap.add_argument('--min-buyers', type=int, default=50)
ap.add_argument('--min-co', type=int, default=10)
ap.add_argument('--top-k', type=int, default=10)
ap.add_argument('--resolution', type=float, default=1.0)
ap.add_argument('--split', type=float, default=0.5)  # découpe les groupes composites (0 : pas de découpage)
ap.add_argument('--split-min', type=int, default=8)
ap.add_argument('--names', default='names.json')  # fichier de noms dans pipeline/ (un par carte)
ap.add_argument('--out', default='graph.json')  # fichier dans site/data/ : plusieurs cartes peuvent coexister
args = ap.parse_args()

ROOT = pathlib.Path(__file__).resolve().parent.parent
ML = pathlib.Path(os.environ.get('WIKIMAP_INPUT', ROOT / 'data' / 'input'))
DATA = ROOT / 'data'
t0 = time.time()
def step(msg): print(f'[{time.time() - t0:5.0f} s] {msg}', flush=True)

c = duckdb.connect()
c.sql(f"create table p as select distinct winner_id, card_id from '{DATA / 'purchases.parquet'}'")
c.sql(f"create table cb as select card_id, count(*) nb from p group by 1 having count(*) >= {args.min_buyers}")
c.sql("create table pe as select p.* from p join cb using (card_id)")
# acheteurs à une seule carte du graphe : aucun lien, on les retire
c.sql("create table bk as select winner_id, count(*) k from pe group by 1 having count(*) >= 2")
c.sql("create table cards as select card_id, row_number() over (order by card_id) - 1 i from cb")
c.sql("create table buyers as select winner_id, k, row_number() over (order by winner_id) - 1 j from bk")
rows, cols, k = c.sql("""select b.j, x.i, b.k from pe join buyers b using (winner_id) join cards x using (card_id) order by 1, 2""").fetchnumpy().values()
n_cards, n_buyers = c.sql('select count(*) from cards').fetchone()[0], c.sql('select count(*) from buyers').fetchone()[0]
step(f'{n_cards:,} cartes, {n_buyers:,} acheteurs, {len(rows):,} achats (acheteur, carte)')

# ---- co-achats : K = Bᵀ B (acheteurs communs), S = Bᵀ W B (pondéré)
B = sparse.csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n_buyers, n_cards))
w = np.zeros(n_buyers)
w[rows] = 1.0 / (k[rows] - 1)
K = (B.T @ B).tocoo()
S = (B.T @ sparse.diags(w) @ B).tocsr()
step(f'{K.nnz:,} paires de cartes avec au moins un acheteur commun')
diag = S.diagonal()
m = (K.row < K.col) & (K.data >= args.min_co)
i, j, co = K.row[m], K.col[m], K.data[m].astype(np.int32)
s = np.asarray(S[i, j]).ravel() / np.sqrt(diag[i] * diag[j])
del K, S
step(f'{len(i):,} paires avec >= {args.min_co} acheteurs communs')

# ---- top-k voisins de chaque carte (un lien est gardé s'il est dans le top-k d'un des deux bouts)
src = np.concatenate([i, j]); dst = np.concatenate([j, i]); ss = np.concatenate([s, s]); idx = np.concatenate([np.arange(len(i))] * 2)
order = np.lexsort((dst, -ss, src))  # dst départage les ex aequo : calcul reproductible
src_o = src[order]
rank = np.arange(len(order)) - np.searchsorted(src_o, src_o)
keep = np.unique(idx[order][rank < args.top_k])
i, j, s, co = i[keep], j[keep], s[keep], co[keep]
step(f'{len(i):,} liens gardés (top {args.top_k} par carte)')

# ---- attributs des nœuds
c.sql(f"""create table attrs as
  select x.i, x.card_id::varchar, k.wikipedia_title title, k.rarity, k.category, k.pageviews, cb.nb buyers,
    s.sales, s.med_price
  from cards x join cb using (card_id)
  left join '{ML / 'cards.parquet'}' k on k.id = x.card_id
  left join (select card_id, count(*) sales, median(final_price) med_price
             from '{DATA / 'purchases.parquet'}' group by 1) s using (card_id)
  order by x.i""")
deg = np.bincount(np.concatenate([i, j]), minlength=n_cards)
strength = np.bincount(np.concatenate([i, j]), weights=np.concatenate([s, s]), minlength=n_cards)
linked = np.flatnonzero(deg > 0)
new = np.full(n_cards, -1); new[linked] = np.arange(len(linked))
attrs = c.sql('select * from attrs').fetchall()
nodes = [dict(id=attrs[o][1], label=attrs[o][2], rarity=attrs[o][3], category=attrs[o][4], pageviews=attrs[o][5],
              buyers=attrs[o][6], sales=attrs[o][7], price=attrs[o][8], degree=int(deg[o]),
              strength=round(float(strength[o]), 3))
         for o in linked]
edges = [[int(new[a]), int(new[b]), round(float(x), 4), int(y)] for a, b, x, y in zip(i, j, s, co)]

# ---- groupes (du plus grand au plus petit : groupe 0 = le plus grand)
G = nx.Graph()
G.add_nodes_from(range(len(nodes)))
G.add_weighted_edges_from((a, b, x) for a, b, x, _ in edges)
com = sorted(nx.community.louvain_communities(G, weight='weight', resolution=args.resolution, seed=1), key=len, reverse=True)
step(f"{len(com)} groupes avant découpage (modularité {nx.community.modularity(G, com, weight='weight'):.3f})")


def split(members):
    """Découpe un groupe fait de plusieurs thèmes collés : Louvain sur ses seuls liens internes.
    Sur un grand graphe, Louvain ne sépare plus les petits groupes reliés par quelques liens (limite de
    résolution de la modularité) : cannabis, champignons et psychiatrie finissent ensemble. On garde le
    découpage si sa modularité interne atteint --split ; les morceaux de moins de --split-min cartes
    rejoignent le morceau auquel ils sont le plus liés. Puis chaque morceau doit peser plus en liens
    internes qu'en liens vers les autres morceaux : sinon (groupe homogène que Louvain coupe au hasard,
    comme les actrices pornographiques) il rejoint le morceau voisin le plus lié, le plus faible d'abord."""
    H = G.subgraph(members)
    sub = nx.community.louvain_communities(H, weight='weight', seed=1)
    if nx.community.modularity(H, sub, weight='weight') < args.split: return [members]
    big = [set(c) for c in sub if len(c) >= args.split_min]
    if len(big) < 2: return [members]
    for c in sub:
        if len(c) >= args.split_min: continue
        w = [sum(d['weight'] for _, b, d in H.edges(c, data=True) if b in p) for p in big]
        big[int(np.argmax(w))] |= c
    while len(big) > 1:
        part = {m: k for k, p in enumerate(big) for m in p}
        W = np.zeros((len(big), len(big)))
        for a, b, d in H.edges(data=True):
            W[part[a], part[b]] += d['weight']
            if part[a] != part[b]: W[part[b], part[a]] += d['weight']
        ratio = [W[k, k] / (W[k].sum() - W[k, k] or 1e-9) for k in range(len(big))]
        k = int(np.argmin(ratio))
        if ratio[k] >= 1: break
        out = W[k].copy(); out[k] = -1
        big[int(np.argmax(out))].update(big[k])
        del big[k]
    return big


if args.split > 0:
    parts = [(k, p) for k, members in enumerate(com) for p in (split(members) if len(members) >= 2 * args.split_min else [members])]
    step(f"découpage : {sum(1 for k in range(len(com)) if sum(1 for f, _ in parts if f == k) > 1)} groupes composites "
         f"découpés, {len(parts)} groupes")
else:
    parts = list(enumerate(com))
parts.sort(key=lambda t: -len(t[1]))
com = [p for _, p in parts]
family = [f for f, _ in parts]  # groupe d'origine avant découpage (même numéro = même grand ensemble)
for gid, members in enumerate(com):
    for m in members: nodes[m]['group'] = gid
between = {}
for a, b, _, _ in edges:
    ga, gb = nodes[a]['group'], nodes[b]['group']
    if ga != gb:
        for x, y in ((ga, gb), (gb, ga)): between.setdefault(x, {}).setdefault(y, 0); between[x][y] += 1
groups = [dict(id=gid, size=len(members), **(dict(family=family[gid]) if args.split > 0 else {}),
               top=[nodes[m]['label'] for m in sorted(members, key=lambda m: -nodes[m]['strength'])[:5]],
               links=dict(sorted(((str(k), v) for k, v in between.get(gid, {}).items()), key=lambda t: -t[1])))
          for gid, members in enumerate(com)]
step(f"{len(com)} groupes (modularité {nx.community.modularity(G, com, weight='weight'):.3f}), "
     f"{sum(1 for c in com if len(c) >= 10)} de 10 cartes ou plus")

# ---- chiffres affichés en pied de page de la map
first, last, n_purchases, n_collectors = c.sql(f"""select min(settled_at)::date::varchar, max(settled_at)::date::varchar,
  count(*), count(distinct winner_id) from '{DATA / 'purchases.parquet'}'""").fetchone()
data = dict(first_sale=first, last_sale=last, purchases=n_purchases, collectors=n_collectors)

graph = apply_names(dict(
    params={k: v for k, v in vars(args).items() if k not in ('out', 'names')} | dict(generated=time.strftime('%Y-%m-%d %H:%M'), dropped=int(n_cards - len(linked))),
    data=data,
    nodes=nodes,
    edges=edges,
    groups=groups,
), args.names)
OUT = ROOT / 'site' / 'data'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / args.out).write_text(json.dumps(graph, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
step(f'{len(linked):,} cartes liées ({n_cards - len(linked):,} sans lien retirées), {len(edges):,} liens -> site/data/{args.out}')
