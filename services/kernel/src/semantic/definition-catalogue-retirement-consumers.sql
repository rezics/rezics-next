-- This page is dispatched only with current Source owner/nonrevival verification.
WITH page AS MATERIALIZED (
 SELECT root_digest,id,sequence FROM semantic.definition_catalogue_consumer c
 WHERE c.route=0 AND c.root_digest=:root::text AND c.state='invalidated'
 AND NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_frontier f
  WHERE f.route=0 AND f.consumer_root=c.root_digest AND f.consumer_id=c.id LIMIT 1)
 ORDER BY sequence LIMIT 100 FOR UPDATE
), removed AS (
 DELETE FROM semantic.definition_catalogue_consumer c USING page p
 WHERE c.route=0 AND c.root_digest=p.root_digest AND c.id=p.id AND c.sequence=p.sequence RETURNING c.sequence
) SELECT sequence::text FROM removed ORDER BY sequence;
