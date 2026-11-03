WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), keys AS MATERIALIZED (
  SELECT import_id,ordinal FROM library.list_import_anilist
  WHERE route=(SELECT route FROM input) AND account_id=(SELECT account_id FROM input)
  ORDER BY import_id,ordinal LIMIT 100
)
DELETE FROM library.list_import_anilist AS victim USING keys,input
WHERE victim.route=input.route AND victim.account_id=input.account_id
  AND victim.import_id=keys.import_id AND victim.ordinal=keys.ordinal
RETURNING true AS removed;
