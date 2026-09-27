# WikiMap

**La carte des enchères de WikiMasters** : les cartes du jeu que les mêmes collectionneurs achètent
ensemble, regroupées par affinité. Environ 9 500 cartes, 130 groupes nommés (une série, un sport, un
parti…), et les liens de co-achat entre eux.

Projet indépendant, non affilié à WikiMasters.

## Ce que montre la carte

- **Un point, c'est une carte**, achetée aux enchères par au moins 75 collectionneurs différents.
  Plus il est gros, plus la carte est au cœur de son groupe ; l'anneau autour indique sa rareté.
- **Un lien relie deux cartes** achetées par au moins 10 mêmes collectionneurs.
- **Une couleur, c'est un groupe** de cartes souvent collectionnées ensemble.

Aucun identifiant de joueur n'est publié : le site ne contient que des titres de cartes et des
compteurs.

## Méthode

1. **Achats retenus** (`pipeline/buyers.py`) : on écarte les achats qui ne disent rien des goûts
   des collectionneurs : comptes automatisés (achats ou ventes sans pause jour et nuit, ou plus de
   1 000 achats en une journée), revendeurs (plus de la moitié des achats remis en vente dans la
   semaine), ventes répétées entre deux mêmes comptes.
2. **Graphe** (`pipeline/graph.py`) : deux cartes sont liées quand leurs acheteurs se recoupent
   (cosinus, chaque joueur comptant d'autant moins qu'il achète de cartes différentes). Un lien doit
   être porté par au moins 10 collectionneurs ; chaque carte garde ses 10 liens les plus forts.
   Groupes détectés par la méthode de Louvain.
3. **Noms des groupes** (`pipeline/names.json`, appliqués par `pipeline/names.py`) : relus à la
   main. Un nom est rattaché à des cartes, pas à un numéro de groupe, et suit donc son groupe d'un
   calcul à l'autre.
4. **Disposition** (`pipeline/layout.mjs`) : ForceAtlas2, graine fixe.

## Organisation

```
pipeline/   calcul : buyers.py → graph.py → layout.mjs (+ names.py, spread.py)
site/       visionneuse statique (HTML, CSS, JS en canvas 2D, sans bibliothèque)
data/       données locales, jamais versionnées (voir .gitignore)
```

## Lancer le calcul

Prérequis : Python 3.12 et Node 18 ou plus.

```sh
pip install -r requirements.txt
npm install --prefix pipeline
```

Données d'entrée, dans `data/input/` (ou le dossier indiqué par la variable `WIKIMAP_INPUT`), au
format Parquet :

| Fichier | Contenu |
|---|---|
| `winners.parquet` | les ventes conclues : carte, vendeur, acheteur, prix, date |
| `auctions.parquet` | les mises en vente : vendeur, carte, date |
| `cards.parquet` | le catalogue des cartes : titre, rareté, description, popularité |

Facultatif : `data/exclude.txt`, des comptes à écarter d'office (un identifiant par ligne, `#` pour
un commentaire).

Puis, depuis la racine :

```sh
python pipeline/buyers.py      # achats retenus        -> data/purchases.parquet
python pipeline/graph.py       # graphe et groupes     -> site/data/graph.json
node pipeline/layout.mjs       # positions des cartes  -> site/data/graph.json
python pipeline/spread.py      # contrôle : groupes éclatés ou compacts
```

Après une correction de `pipeline/names.json`, `python pipeline/names.py` réapplique les noms sans
tout recalculer.

## Voir le site en local

Le site charge `data/graph.json` par une requête relative : il faut un petit serveur.

```sh
python -m http.server 8000 --directory site
```

puis ouvrir http://localhost:8000.

## Publier

Le site est publié sur Cloudflare (Worker à ressources statiques, voir `wrangler.jsonc`), depuis la
racine, une fois `site/data/graph.json` généré :

```sh
npx wrangler deploy
```

## Licence

Code sous licence [MIT](LICENSE).
