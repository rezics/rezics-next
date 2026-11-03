WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source,
         :digest::text AS digest, :source_alias::text AS source_alias,
         :source_record_id::text AS source_record_id, :as_of::date AS as_of,
         :payload::jsonb AS payload, :transaction_id::uuid AS transaction_id
), observation AS (
  INSERT INTO rating.source_statistic_observation
    (route, subject_id, source, digest, source_alias, source_record_id, as_of, payload, transaction_id)
  SELECT route, subject_id, source, digest, source_alias, source_record_id, as_of, payload, transaction_id FROM input
  ON CONFLICT (route, subject_id, source, digest) DO NOTHING
)
INSERT INTO rating.source_statistic_head (route, subject_id, source, digest)
SELECT route, subject_id, source, digest FROM input
ON CONFLICT (route, subject_id, source) DO UPDATE SET digest = EXCLUDED.digest;
