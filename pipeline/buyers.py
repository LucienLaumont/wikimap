"""buyers.py — profils d'acheteurs et achats retenus pour la map des cartes.

    python pipeline/buyers.py     (depuis la racine du dépôt)

Entrée  : $WIKIMAP_INPUT (défaut data/input/) : winners.parquet (ventes + acheteur),
          auctions.parquet (mises en vente) ; data/exclude.txt, facultatif : comptes à écarter
          d'office, un identifiant par ligne (# pour un commentaire)
Sorties : data/buyers.parquet     une ligne par acheteur : volumes, indicateurs, motif d'exclusion
          data/purchases.parquet  achats retenus (winner_id, card_id, final_price, settled_at)
Ces fichiers contiennent des identifiants de joueurs : ils restent en local (.gitignore).

Retiré de la map :
  - ventes sans acheteur, ou vendeur = acheteur ;
  - ventes des comptes de data/exclude.txt et des vendeurs bots (aucune pause de 3 h la plupart des jours) ;
  - ventes des paires complices : >= 10 ventes du même vendeur au même acheteur formant la majorité
    des achats de l'un ou des ventes de l'autre, ou allers-retours (>= 5 ventes dans chaque sens) ;
  - acheteurs bots (même critère d'absence de pause sur leurs achats, ou >= 1 000 achats en une
    journée), revendeurs (>= 50 % des
    achats remis en vente sous 7 jours) et complices (majorité des achats chez un seul vendeur).
Les gros acheteurs restent : ils sont pondérés à l'étape suivante (graph.py).
"""
import duckdb, os, pathlib, time

ROOT = pathlib.Path(__file__).resolve().parent.parent
ML = pathlib.Path(os.environ.get('WIKIMAP_INPUT', ROOT / 'data' / 'input'))
OUT = ROOT / 'data'
OUT.mkdir(exist_ok=True)

EXCLUDE_FILE = OUT / 'exclude.txt'
EXCLUDED = [l.split('#')[0].strip() for l in EXCLUDE_FILE.read_text(encoding='utf-8').splitlines()] if EXCLUDE_FILE.exists() else []
EXCLUDED = [x for x in EXCLUDED if x]
BOT_MIN_EVENTS, BOT_MIN_DAYS, BOT_NO_PAUSE, BOT_PAUSE_H = 500, 5, 50, 3  # >= 50 % de jours sans pause de 3 h
PAIR_MIN, PAIR_SHARE, ROUNDTRIP_MIN = 10, 0.5, 5
RESALE_DAYS, RESALE_SHARE, RESALE_MIN_BUYS = 7, 0.5, 10
BOT_MAX_DAY = 1000  # achats en une journée : 3 comptes au-dessus (1 382 à 14 516), aucun autre au-delà de 900

t0 = time.time()
def step(msg): print(f'[{time.time() - t0:5.0f} s] {msg}', flush=True)

c = duckdb.connect()
c.sql("set timezone = 'UTC'")
c.sql('create table excl (id varchar)')
if EXCLUDED: c.executemany('insert into excl values (?)', [[x] for x in EXCLUDED])
step(f'{len(EXCLUDED)} comptes écartés d\'office ({EXCLUDE_FILE.name})')
c.sql(f"""create table w as
  select id, card_id, seller_id::varchar seller_id, winner_id::varchar winner_id, final_price,
         settled_at::timestamptz settled_at
  from '{ML / 'winners.parquet'}'
  where winner_id is not null and winner_id <> seller_id""")
c.sql(f"create view a as select seller_id::varchar seller_id, card_id, created_at from '{ML / 'auctions.parquet'}'")
step(f"{c.sql('select count(*) from w').fetchone()[0]:,} ventes avec un acheteur distinct du vendeur")

# ---- comptes sans pause (bots) : sur les mises en vente (vendeurs) et sur les achats (acheteurs)
# Jour « plein » = jour actif précédé et suivi d'un jour actif ; on compte ceux dont le plus long
# écart entre deux événements consécutifs reste sous BOT_PAUSE_H.
def no_pause(events_sql, name):
    c.sql(f"""create table {name} as
    with e as ({events_sql}),
    big as (select who from e group by 1 having count(*) >= {BOT_MIN_EVENTS}),
    x as (select who, t, epoch(t - lag(t) over (partition by who order by t)) / 3600 gap_h
          from e join big using (who)),
    g as (select who, date_trunc('day', t) d, max(gap_h) max_gap from x group by 1, 2)
    select g.who, count(*) n_days,100.0 * count(*) filter (where g.max_gap < {BOT_PAUSE_H}) / count(*) pct
    from g join g g0 on g0.who = g.who and g0.d = g.d - interval 1 day
           join g g1 on g1.who = g.who and g1.d = g.d + interval 1 day
    group by 1 having count(*) >= {BOT_MIN_DAYS}""")
    return c.sql(f"select count(*) from {name} where pct >= {BOT_NO_PAUSE}").fetchone()[0]

n = no_pause('select seller_id who, created_at t from a', 'seller_np')
step(f'{n} vendeurs bots (mises en vente sans pause)')
n = no_pause('select winner_id who, settled_at t from w', 'buyer_np')
step(f'{n} acheteurs bots (achats sans pause)')
c.sql("""create table buyer_day as select winner_id, max(n) max_day
         from (select winner_id, settled_at::date, count(*) n from w group by 1, 2) group by 1""")
n = c.sql(f'select count(*) from buyer_day where max_day >= {BOT_MAX_DAY}').fetchone()[0]
step(f'{n} acheteurs à >= {BOT_MAX_DAY} achats en une journée')

# ---- paires complices
c.sql("create table pr as select seller_id, winner_id, count(*) n from w group by 1, 2")
c.sql("create table nb as select winner_id, count(*) nb from w group by 1")
c.sql("create table ns as select seller_id, count(*) ns from w group by 1")
c.sql(f"""create table bad_pair as
  select p.seller_id, p.winner_id, p.n, p.n >= {PAIR_SHARE} * nb.nb buyer_majority
  from pr p join nb using (winner_id) join ns using (seller_id)
  where p.n >= {PAIR_MIN} and (p.n >= {PAIR_SHARE} * nb.nb or p.n >= {PAIR_SHARE} * ns.ns)
  union
  select p.seller_id, p.winner_id, p.n, false
  from pr p join pr q on q.seller_id = p.winner_id and q.winner_id = p.seller_id
  where p.n >= {ROUNDTRIP_MIN} and q.n >= {ROUNDTRIP_MIN}""")
step(f"{c.sql('select count(*), sum(n) from bad_pair').fetchone()} paires complices (paires, ventes)")

# ---- reventes : l'acheteur remet la même carte en vente dans les RESALE_DAYS jours
c.sql(f"""create table rs as
  select w.winner_id, count(*) buys,
    count(*) filter (where exists (
      select 1 from a where a.seller_id = w.winner_id and a.card_id = w.card_id
        and a.created_at > w.settled_at and a.created_at < w.settled_at + interval {RESALE_DAYS} day)) resold
  from w group by 1""")
step('reventes calculées')

# ---- profil acheteur et motif d'exclusion (le premier qui s'applique)
c.sql(f"""create table buyers as
  select rs.winner_id, rs.buys, round(100.0 * rs.resold / rs.buys, 1) pct_resold,
    count(distinct w.seller_id) sellers, round(avg(w.final_price)) avg_price,
    bnp.n_days np_days, round(bnp.pct, 1) pct_no_pause, bd.max_day,
    case
      when rs.winner_id in (select id from excl) then 'exclu'
      when bnp.pct >= {BOT_NO_PAUSE} or bd.max_day >= {BOT_MAX_DAY} then 'bot'
      when rs.buys >= {RESALE_MIN_BUYS} and rs.resold >= {RESALE_SHARE} * rs.buys then 'revendeur'
      when rs.winner_id in (select winner_id from bad_pair where buyer_majority) then 'complice'
    end excluded
  from rs join w using (winner_id) join buyer_day bd using (winner_id)
  left join buyer_np bnp on bnp.who = rs.winner_id
  group by rs.winner_id, rs.buys, rs.resold, bnp.n_days, bnp.pct, bd.max_day""")
c.sql(f"copy buyers to '{OUT / 'buyers.parquet'}' (format parquet)")
for r in c.sql("""select coalesce(excluded, 'retenu') k, count(*) acheteurs, sum(buys) achats
                  from buyers group by 1 order by 3 desc""").fetchall():
    print(f'  {r[0]:<10} {r[1]:>8,} acheteurs {r[2]:>10,} achats')

# ---- achats retenus
c.sql(f"""copy (
  select w.winner_id, w.card_id, w.final_price, w.settled_at
  from w join buyers b using (winner_id)
  where b.excluded is null
    and w.seller_id not in (select id from excl)
    and w.seller_id not in (select who from seller_np where pct >= {BOT_NO_PAUSE})
    and not exists (select 1 from bad_pair p where p.seller_id = w.seller_id and p.winner_id = w.winner_id)
) to '{OUT / 'purchases.parquet'}' (format parquet)""")
n, nb_, nc = c.sql(f"select count(*), count(distinct winner_id), count(distinct card_id) from '{OUT / 'purchases.parquet'}'").fetchone()
step(f'{n:,} achats retenus, {nb_:,} acheteurs, {nc:,} cartes -> data/purchases.parquet')
