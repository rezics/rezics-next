WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source,
         :cursor_digest::text AS cursor_digest, :ceiling_digest::text AS ceiling_digest,
         :boundary_digest::text AS boundary_digest, p.epoch::text AS "subjectEpoch"
  FROM core.partition AS p
  WHERE p.partition_no = (:route::integer >> 4)
), boundary AS (
  SELECT (input.boundary_digest IS NULL) OR EXISTS (
    SELECT 1 FROM rating.source_statistic_observation AS retained
    WHERE retained.route = input.route AND retained.subject_id = input.subject_id
      AND retained.source = input.source AND retained.local_order IS NULL
      AND retained.digest = input.boundary_digest
  ) AS "cursorRetained"
  FROM input
), page AS (
  SELECT observation.digest, observation.source_alias AS "sourceAlias",
         observation.source_record_id AS "sourceRecordId",
         observation.as_of::text AS "asOf", observation.payload_version AS "payloadVersion",
         NULL::text AS "nativeOrder", true AS legacy
  FROM rating.source_statistic_observation AS observation
  CROSS JOIN input
  WHERE observation.route = input.route AND observation.subject_id = input.subject_id
    AND observation.source = input.source AND observation.local_order IS NULL
    AND (input.cursor_digest IS NULL OR observation.digest < input.cursor_digest)
    AND (input.ceiling_digest IS NULL OR observation.digest <= input.ceiling_digest)
  ORDER BY observation.digest DESC
  LIMIT 2
)
SELECT page.digest, page."sourceAlias", page."sourceRecordId", page."asOf", page."payloadVersion",
       page."nativeOrder", page.legacy, (page.digest IS NOT NULL) AS "hasRow",
       boundary."cursorRetained", input."subjectEpoch"
FROM boundary LEFT JOIN page ON true CROSS JOIN input;
