"""names.py — donne leur nom aux groupes de la map à partir de pipeline/names.json.

    python pipeline/names.py     (depuis la racine : réapplique les noms à site/data/graph.json,
                                  après une correction de names.json, sans tout recalculer)

graph.py appelle apply_names() à chaque recalcul. Un nom est rattaché à des cartes, pas à un
numéro de groupe (les numéros changent d'un calcul à l'autre) : il va au groupe qui contient au
moins la moitié de ses cartes encore présentes sur la map. En cas de concurrence, la meilleure
correspondance passe d'abord ; un groupe ne reçoit qu'un nom. Les groupes de 5 cartes ou plus
restés sans nom sont listés pour être nommés à la main.
"""
import json, pathlib

NAMES = pathlib.Path(__file__).parent / 'names.json'
GRAPH = pathlib.Path(__file__).resolve().parent.parent / 'site' / 'data' / 'graph.json'
MIN_SHARE = 0.5


def apply_names(graph):
    entries = json.loads(NAMES.read_text(encoding='utf-8'))['groups'] if NAMES.exists() else []
    group_of = {n['id']: n['group'] for n in graph['nodes']}
    candidates = []
    for k, e in enumerate(entries):
        present = [group_of[c] for c in e['cards'] if c in group_of]
        if not present: continue
        for gid in set(present):
            share = present.count(gid) / len(present)
            if share >= MIN_SHARE: candidates.append((share, len(present), k, gid))
    used, named = set(), {}
    for share, _, k, gid in sorted(candidates, reverse=True):
        if k in used or gid in named: continue
        used.add(k); named[gid] = entries[k]['name']
    for g in graph['groups']:
        g['name'] = named.get(g['id'])
    lost = [e['name'] for k, e in enumerate(entries) if k not in used]
    unnamed = [g for g in graph['groups'] if g['size'] >= 5 and not g['name']]
    print(f'noms : {len(named)} groupes nommés, {len(unnamed)} groupes de 5+ cartes sans nom, {len(lost)} noms non replacés')
    for g in unnamed: print(f"  sans nom : groupe {g['id']} ({g['size']} cartes) : {', '.join(g['top'][:4])}")
    for name in lost: print(f'  nom non replacé : {name}')
    return graph


if __name__ == '__main__':
    g = apply_names(json.loads(GRAPH.read_text(encoding='utf-8')))
    GRAPH.write_text(json.dumps(g, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
