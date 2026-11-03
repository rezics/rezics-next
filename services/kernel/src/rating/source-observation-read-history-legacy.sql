WITH input AS NOT MATERIALIZED (
  SELECT :cursor_digest::text AS cursor_digest
)
SELECT observation.digest, observation.source_alias AS "sourceAlias",
       observation.source_record_id AS "sourceRecordId",
       observation.as_of::text AS "asOf", observation.payload_version AS "payloadVersion",
       NULL::text AS "nativeOrder", true AS legacy
FROM rating.source_statistic_observation AS observation
CROSS JOIN input
WHERE observation.route = :route::integer AND observation.subject_id = :subject_id::uuid
  AND observation.source = :source::text AND observation.local_order IS NULL
  AND (input.cursor_digest IS NULL OR observation.digest < input.cursor_digest)
ORDER BY observation.digest DESC
LIMIT 2;
