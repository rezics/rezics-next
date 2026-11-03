WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id,
         :source::text AS source, :source_alias::text AS source_alias, :source_record_id::text AS source_record_id,
         :scale_min::integer AS scale_min, :scale_max::integer AS scale_max,
         :mean::numeric AS mean, :count::integer AS count, :as_of::date AS as_of,
         :licence::text AS licence, :attribution::text AS attribution,
         :transaction_id::uuid AS transaction_id, :observation_digest::text AS observation_digest, :expose_observation::boolean AS expose_observation
)
INSERT INTO rating.source_statistic
  (route, subject_id, source, source_alias, source_record_id, scale_min, scale_max, mean, count, as_of, licence, attribution,
   transaction_id, observation_digest)
SELECT i.route, subject.subject_id, i.source, i.source_alias, i.source_record_id,
       i.scale_min, i.scale_max, i.mean, i.count, i.as_of, i.licence, i.attribution, i.transaction_id, CASE WHEN i.expose_observation THEN i.observation_digest ELSE NULL END
FROM input AS i JOIN semantic.subject AS subject
  ON subject.route = i.route AND subject.subject_id = i.subject_id
ON CONFLICT (route, subject_id, source) DO UPDATE
SET source_alias = EXCLUDED.source_alias,
    source_record_id = EXCLUDED.source_record_id,
    scale_min = EXCLUDED.scale_min,
    scale_max = EXCLUDED.scale_max,
    mean = EXCLUDED.mean,
    count = EXCLUDED.count,
    as_of = EXCLUDED.as_of,
    licence = EXCLUDED.licence,
    attribution = EXCLUDED.attribution,
    transaction_id = EXCLUDED.transaction_id,
    observation_digest = EXCLUDED.observation_digest
RETURNING route, subject_id::text AS "subjectId", source, source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
          scale_min AS "scaleMin", scale_max AS "scaleMax", mean::text AS mean,
          count, as_of::text AS "asOf", licence, attribution, observation_digest AS "observationDigest";
