-- Terminal originals retain immutable admitted/spent totals and native identity.
WITH page AS MATERIALIZED (
 SELECT t.original_key,t.slot FROM (
  SELECT original_key FROM semantic.definition_catalogue_original
  WHERE route=0 AND root_digest=:root::text AND state='terminal' AND original_key=:original_key::text
  ORDER BY original_key LIMIT 1 FOR UPDATE
 ) o JOIN semantic.definition_catalogue_ticket t ON t.route=0 AND t.original_key=o.original_key
 WHERE t.state='spent' ORDER BY t.original_key,t.slot LIMIT 7 FOR UPDATE OF t
), removed AS (
 DELETE FROM semantic.definition_catalogue_ticket t USING page p
 WHERE t.route=0 AND t.original_key=p.original_key AND t.slot=p.slot RETURNING t.original_key,t.slot
) SELECT original_key,slot FROM removed ORDER BY original_key,slot;
