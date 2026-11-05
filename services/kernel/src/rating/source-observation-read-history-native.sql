WITH request AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source,
         :cursor_order::bigint AS cursor_order, :cursor_digest::text AS cursor_digest,
         :ceiling_order::bigint AS ceiling_order
), input AS NOT MATERIALIZED (
  SELECT request.route, request.subject_id, request.source, request.cursor_order,
         request.cursor_digest, request.ceiling_order, p.epoch::text AS "subjectEpoch"
  FROM request
  JOIN core.partition AS p ON p.partition_no = (request.route >> 4)
), boundary AS (
  SELECT (input.cursor_order IS NULL AND input.cursor_digest IS NULL) OR EXISTS (
    SELECT 1 FROM rating.source_statistic_observation AS retained
    WHERE retained.route = input.route AND retained.subject_id = input.subject_id
      AND retained.source = input.source AND retained.local_order = input.cursor_order
      AND retained.digest = input.cursor_digest
  ) AS "cursorRetained"
  FROM input
), page AS (
  SELECT observation.digest, observation.source_alias AS "sourceAlias",
         observation.source_record_id AS "sourceRecordId",
         observation.as_of::text AS "asOf", observation.payload_version AS "payloadVersion",
         observation.local_order::text AS "nativeOrder", false AS legacy
  FROM rating.source_statistic_observation AS observation
  CROSS JOIN input
  WHERE observation.route = input.route AND observation.subject_id = input.subject_id
    AND observation.source = input.source AND observation.local_order IS NOT NULL
    AND (input.cursor_order IS NULL OR observation.local_order < input.cursor_order)
    AND (input.ceiling_order IS NULL OR observation.local_order <= input.ceiling_order)
  ORDER BY observation.local_order DESC
  LIMIT 2
)
SELECT page.digest, page."sourceAlias", page."sourceRecordId", page."asOf", page."payloadVersion",
       page."nativeOrder", page.legacy, (page.digest IS NOT NULL) AS "hasRow",
       boundary."cursorRetained", input."subjectEpoch"
FROM boundary LEFT JOIN page ON true CROSS JOIN input;
