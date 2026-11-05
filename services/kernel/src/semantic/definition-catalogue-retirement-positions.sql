WITH page AS MATERIALIZED (
 SELECT p.root_digest,p.phase,p.native_position FROM (
  SELECT root_digest,phase,native_position,original_key FROM semantic.definition_catalogue_position
  WHERE route=0 AND root_digest=:root::text ORDER BY phase,native_position LIMIT 100 FOR UPDATE
 ) p JOIN semantic.definition_catalogue_original o ON o.route=0 AND o.original_key=p.original_key
 WHERE o.state='terminal' AND o.spent=o.admitted
), removed AS (
 DELETE FROM semantic.definition_catalogue_position p USING page q
 WHERE p.route=0 AND p.root_digest=q.root_digest AND p.phase=q.phase AND p.native_position=q.native_position
 RETURNING p.phase,p.native_position::text
) SELECT phase,native_position FROM removed;
