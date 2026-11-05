WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,:collection_id::uuid AS collection_id,:account_id::uuid AS account_id,
         :audience::text AS audience,:generation::uuid AS generation,:votes::jsonb AS votes
), inserted AS (
  INSERT INTO library.collection_kind_subject
    (route,collection_id,account_id,audience,generation,subject_id,type_id)
  SELECT input.route,input.collection_id,input.account_id,input.audience,input.generation,vote.subject_id,vote.type_id
  FROM input CROSS JOIN LATERAL jsonb_to_recordset(input.votes) AS vote(subject_id uuid,type_id text)
  ON CONFLICT DO NOTHING
  RETURNING type_id
), additions AS (
  SELECT type_id,count(*) AS votes FROM inserted GROUP BY type_id
)
INSERT INTO library.collection_kind_count(route,collection_id,account_id,audience,generation,type_id,votes)
SELECT input.route,input.collection_id,input.account_id,input.audience,input.generation,additions.type_id,additions.votes
FROM input,additions
ON CONFLICT (route,collection_id,audience,generation,type_id) DO UPDATE
SET votes=library.collection_kind_count.votes+EXCLUDED.votes;
