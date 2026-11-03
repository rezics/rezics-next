WITH input AS NOT MATERIALIZED (
  SELECT :cursor_order::bigint AS cursor_order
)
SELECT observation.digest, observation.source_alias AS "sourceAlias",
       observation.source_record_id AS "sourceRecordId",
       observation.as_of::text AS "asOf", observation.payload_version AS "payloadVersion",
       observation.local_order::text AS "nativeOrder", false AS legacy
FROM rating.source_statistic_observation AS observation
CROSS JOIN input
WHERE observation.route = :route::integer AND observation.subject_id = :subject_id::uuid
  AND observation.source = :source::text AND observation.local_order IS NOT NULL
  AND (input.cursor_order IS NULL OR observation.local_order < input.cursor_order)
ORDER BY observation.local_order DESC
LIMIT 2;
