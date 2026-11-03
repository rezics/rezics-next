WITH observation AS (
  INSERT INTO rating.source_statistic_observation
    (route, subject_id, source, digest, source_alias, source_record_id, as_of, payload, transaction_id)
  VALUES (:route::integer, :subject_id::uuid, :source::text, :digest::text,
          :source_alias::text, :source_record_id::text, :as_of::date, :payload::jsonb, :transaction_id::uuid)
  ON CONFLICT (route, subject_id, source, digest) DO NOTHING
)
INSERT INTO rating.source_statistic_head (route, subject_id, source, digest)
VALUES (:route::integer, :subject_id::uuid, :source::text, :digest::text)
ON CONFLICT (route, subject_id, source) DO UPDATE SET digest = EXCLUDED.digest;
