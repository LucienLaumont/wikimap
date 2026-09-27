"""spread.py — mesure l'éclatement des groupes sur la map (contrôle de layout.mjs).

    python pipeline/spread.py    (depuis la racine)

Pour chaque disposition de site/data/graph.json et chaque groupe nommé : part des cartes
situées loin du cœur du groupe (plus de 4 fois la distance médiane de ses cartes à ce cœur, avec
un plancher proportionnel à la taille du groupe). Un groupe compact est à 0 %, un groupe coupé en
deux morceaux éloignés approche 50 %. Aussi : le rayon de la carte en rayons de point médian
(compacité) et le rapport des distances entre groupes sans lien et groupes liés.
"""
import json, pathlib
import numpy as np

g = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'site' / 'data' / 'graph.json').read_text(encoding='utf-8'))
N, GR = g['nodes'], g['groups']
strength = np.array([n['strength'] for n in N])
for name, L in g['layouts'].items():
    P = np.array(L['xy']).reshape(-1, 2)
    d_nn = np.median([np.sort(np.linalg.norm(P[np.random.default_rng(0).integers(0, len(P), 1)] - P, axis=1))[1]])
    rows = []
    for G in GR:
        if not G.get('name'): continue
        m = np.array([i for i, n in enumerate(N) if n['group'] == G['id']])
        c = P[m[np.argmax(strength[m])]]
        for _ in range(6):  # même cœur que la visionneuse : voisines de la carte la plus centrale
            d = np.linalg.norm(P[m] - c, axis=1)
            c = P[m[np.argsort(d)[:max(3, int(np.ceil(len(m) * 0.4)))]]].mean(0)
        d = np.linalg.norm(P[m] - c, axis=1)
        far = (d > max(4 * np.median(d), 1)).mean()
        rows.append((far, G['name'], G['size']))
    rows.sort(reverse=True)
    # compacité : rayon contenant 95 % des cartes, en rayons de point médian (plus bas = plus serré)
    size = np.median([n['size'] for n in N])
    r95 = np.quantile(np.linalg.norm(P - np.median(P, 0), axis=1), 0.95) / size
    # sens des distances entre groupes : groupes sans lien / groupes liés (> 1 = les liés sont plus proches)
    grp = np.array([n['group'] for n in N]); big = [G for G in GR if G['size'] >= 10]
    C = {G['id']: np.median(P[grp == G['id']], 0) for G in big}
    lk, nl = [], []
    for a in big:
        for b in big:
            if a['id'] < b['id']: (lk if str(b['id']) in a['links'] else nl).append(np.linalg.norm(C[a['id']] - C[b['id']]))
    print(f"{name} : éclatés (> 10 % de cartes loin du cœur) {sum(1 for r in rows if r[0] > 0.1)}/{len(rows)} · "
          f"rayon {r95:.0f} points · sans lien / liés {np.median(nl) / np.median(lk):.2f}")
    for far, nm, size in rows[:12]: print(f'   {far:4.0%}  {nm} ({size})')
