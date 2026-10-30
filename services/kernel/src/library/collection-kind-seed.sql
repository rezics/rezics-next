WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:collection_id::uuid AS collection_id,:account_id::uuid AS account_id,
         :audience::text AS audience,:generation::uuid AS generation,
         :source_generation::text::bigint AS source_generation,:capture::text AS capture
), previous AS MATERIALIZED (
  SELECT observation.* FROM library.collection_kind_observation AS observation,input
  WHERE observation.route=input.route AND observation.collection_id=input.collection_id AND observation.audience=input.audience
  FOR UPDATE OF observation
), retired AS (
  INSERT INTO library.collection_kind_retired(route,collection_id,account_id,audience,generation,capture)
  SELECT previous.route,previous.collection_id,previous.account_id,previous.audience,previous.generation,previous.capture
  FROM previous,input
  WHERE previous.capture<>input.capture OR previous.source_generation<>input.source_generation
  ON CONFLICT DO NOTHING
)
INSERT INTO library.collection_kind_observation
  (route,collection_id,account_id,audience,generation,source_generation,capture)
SELECT route,collection_id,account_id,audience,generation,source_generation,capture FROM input
ON CONFLICT (route,collection_id,audience) DO UPDATE
SET generation=EXCLUDED.generation,source_generation=EXCLUDED.source_generation,capture=EXCLUDED.capture,
    account_id=EXCLUDED.account_id,after_subject=NULL,frontier=NULL,version=0,complete=false,winner=NULL
WHERE library.collection_kind_observation.capture<>EXCLUDED.capture
   OR library.collection_kind_observation.source_generation<>EXCLUDED.source_generation
RETURNING generation::text;
