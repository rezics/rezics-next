WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source,
         :digest::text AS digest, p.epoch::text AS "subjectEpoch"
  FROM core.partition AS p
  WHERE p.partition_no = (:route::integer >> 4)
)
SELECT observation.digest, observation.source_alias AS "sourceAlias",
       observation.source_record_id AS "sourceRecordId",
       observation.as_of::text AS "asOf", observation.payload_version AS "payloadVersion",
       observation.local_order::text AS "nativeOrder", observation.local_order IS NULL AS legacy,
       input."subjectEpoch"
FROM rating.source_statistic_observation AS observation
CROSS JOIN input
WHERE observation.route = input.route AND observation.subject_id = input.subject_id
  AND observation.source = input.source AND observation.digest = input.digest;
