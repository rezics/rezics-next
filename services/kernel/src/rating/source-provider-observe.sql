WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source,
         :digest::text AS digest, :source_alias::text AS source_alias,
         :source_record_id::text AS source_record_id, :as_of::date AS as_of,
         :payload::text::jsonb AS payload, :transaction_id::uuid AS transaction_id,
         :payload_version::smallint AS payload_version,
         :local_order::bigint AS local_order, :last_order::bigint AS last_order
), inserted AS (
  INSERT INTO rating.source_statistic_observation
    (route, subject_id, source, digest, source_alias, source_record_id, as_of, payload, transaction_id,
     payload_version, local_order)
  SELECT route, subject_id, source, digest, source_alias, source_record_id, as_of, payload, transaction_id,
         payload_version, local_order
  FROM input
  ON CONFLICT (route, subject_id, source, digest) DO NOTHING
  RETURNING local_order
), head AS (
  INSERT INTO rating.source_statistic_head (route, subject_id, source, digest, last_order)
  SELECT input.route, input.subject_id, input.source, input.digest,
         CASE WHEN EXISTS (SELECT 1 FROM inserted WHERE local_order IS NOT NULL)
              THEN GREATEST(input.last_order, input.local_order)
              ELSE input.last_order
         END
  FROM input
  ON CONFLICT (route, subject_id, source) DO UPDATE
    SET digest = EXCLUDED.digest,
        last_order = GREATEST(rating.source_statistic_head.last_order, EXCLUDED.last_order)
  RETURNING 1
)
SELECT 1 FROM head;
