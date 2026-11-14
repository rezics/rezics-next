WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source
)
SELECT head.digest, head.last_order::text AS "lastOrder",
       head.last_seek_order::text AS "lastSeekOrder",
       observation.local_order::text AS "nativeOrder",
       observation.payload_version AS "payloadVersion",
       observation.source_alias AS "sourceAlias",
       observation.source_record_id AS "sourceRecordId", observation.as_of::text AS "asOf",
       observation.payload,
       CASE WHEN head.digest IS NULL THEN
         projection.subject_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM rating.source_statistic_observation AS retained
           WHERE retained.route = input.route AND retained.subject_id = input.subject_id
             AND retained.source = input.source
         )
       ELSE
         head.last_seek_order = 0 OR observation.seek_order IS NULL OR
         (((observation.payload->>'count')::integer > 0) <> (projection.subject_id IS NOT NULL)) OR
         (projection.subject_id IS NOT NULL AND projection.observation_digest IS DISTINCT FROM head.digest)
       END OR EXISTS (
         SELECT 1 FROM rating.source_statistic_observation AS unkeyed
         WHERE unkeyed.route = input.route AND unkeyed.subject_id = input.subject_id
           AND unkeyed.source = input.source AND unkeyed.seek_order IS NULL
       ) AS "needsMaterialization"
FROM input
LEFT JOIN rating.source_statistic_head AS head
  ON head.route = input.route AND head.subject_id = input.subject_id AND head.source = input.source
LEFT JOIN rating.source_statistic_observation AS observation
  ON observation.route = head.route AND observation.subject_id = head.subject_id
 AND observation.source = head.source AND observation.digest = head.digest
LEFT JOIN rating.source_statistic AS projection
  ON projection.route = input.route AND projection.subject_id = input.subject_id AND projection.source = input.source;
