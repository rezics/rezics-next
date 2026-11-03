WITH keys AS MATERIALIZED (
  SELECT import_id,ordinal FROM library.list_import_anilist
  WHERE route=:route::integer AND account_id=:account_id::uuid
  ORDER BY import_id,ordinal LIMIT 100
)
DELETE FROM library.list_import_anilist AS victim USING keys
WHERE victim.route=:route::integer AND victim.account_id=:account_id::uuid
  AND victim.import_id=keys.import_id AND victim.ordinal=keys.ordinal
RETURNING true AS removed;
