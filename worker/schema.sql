-- Compteur de visites de WikiMap : un seul nombre, rien sur les visiteurs.
--   npx wrangler d1 execute wikimap --remote --file worker/schema.sql
create table if not exists counter (id text primary key, n integer not null default 0);
insert or ignore into counter (id, n) values ('visits', 0);
