WITH input AS MATERIALIZED (
 SELECT :original_key::text AS key,:root::text AS root,:phase::text AS phase,
 :input_digest::bytea AS digest,:episode::uuid AS episode,:deadline::text::bigint AS deadline,
 :admitted::text::bigint[] AS admitted,:position::text::bigint AS position
), saved AS (
 INSERT INTO semantic.definition_catalogue_original(route,original_key,owner,root_digest,phase,origin,input_digest,episode,deadline_ms,admitted,position)
 SELECT 0,key,'semantic.catalogue',root,phase,'command',digest,episode,deadline,admitted,position FROM input
 WHERE NOT EXISTS (SELECT 1 FROM semantic.definition_catalogue_retirement r WHERE r.route=0 AND r.root_digest=input.root LIMIT 1)
 ON CONFLICT DO NOTHING RETURNING original_key
) SELECT original_key FROM saved LIMIT 1;
