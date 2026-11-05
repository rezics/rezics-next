-- An origin is control state, not an Actor or a cached permission decision.
WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,:origin_id::text AS origin_id,:owner_account_id::uuid AS owner_account_id,
         :collection_id::uuid AS collection_id,:preparation_id::uuid AS preparation_id,:audience::text AS audience,
         :original_digest::text AS original_digest,:formula_digest::text AS formula_digest,
         :source_generation::text::bigint AS source_generation,:source_capture::text AS source_capture,
         :origin_at::timestamptz AS origin_at,:expires_at::timestamptz AS expires_at,
         :deadline_at::text::bigint AS deadline_at
), retired AS (
  DELETE FROM library.collection_kind_audience_origin AS original USING input
  WHERE original.route=input.route AND original.collection_id=input.collection_id AND original.audience=input.audience
    AND original.preparation_id<>input.preparation_id
  RETURNING original.origin_id
)
INSERT INTO library.collection_kind_audience_origin
  (route,origin_id,owner_account_id,collection_id,preparation_id,audience,
   original_digest,formula_digest,source_generation,source_capture,origin_at,expires_at,deadline_at)
SELECT input.route,input.origin_id,input.owner_account_id,input.collection_id,input.preparation_id,input.audience,
       input.original_digest,input.formula_digest,input.source_generation,input.source_capture,
       input.origin_at,input.expires_at,input.deadline_at
FROM input CROSS JOIN (SELECT count(*) FROM retired) AS retirement
ON CONFLICT DO NOTHING
RETURNING origin_id AS id;
