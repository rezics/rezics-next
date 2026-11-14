WITH request AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source
), input AS NOT MATERIALIZED (
  SELECT request.route, request.subject_id, request.source, p.epoch::text AS "subjectEpoch"
  FROM request
  JOIN core.partition AS p ON p.partition_no = (request.route >> 4)
), retained AS (
  SELECT head.digest, observation.source_alias AS "sourceAlias",
         observation.source_record_id AS "sourceRecordId", observation.as_of::text AS "asOf",
         observation.payload_version AS "payloadVersion",
         observation.local_order::text AS "nativeOrder",
         observation.seek_order::text AS "seekOrder",
         observation.local_order IS NULL AS legacy, input."subjectEpoch"
  FROM rating.source_statistic_head AS head
  JOIN rating.source_statistic_observation AS observation
    ON observation.route = head.route AND observation.subject_id = head.subject_id
   AND observation.source = head.source AND observation.digest = head.digest
  CROSS JOIN input
  WHERE head.route = input.route AND head.subject_id = input.subject_id AND head.source = input.source

)
SELECT retained.*, input."subjectEpoch" AS "emptySubjectEpoch",
       EXISTS (SELECT 1 FROM rating.source_statistic AS projection
               WHERE projection.route = input.route AND projection.subject_id = input.subject_id
                 AND projection.source = input.source) AS "projectionExists",
       CASE WHEN retained.digest IS NULL THEN
         EXISTS (SELECT 1 FROM rating.source_statistic AS statistic
                 WHERE statistic.route = input.route AND statistic.subject_id = input.subject_id
                   AND statistic.source = input.source)
         OR EXISTS (SELECT 1 FROM rating.source_statistic_observation AS observation
                    WHERE observation.route = input.route AND observation.subject_id = input.subject_id
                      AND observation.source = input.source)
         OR EXISTS (SELECT 1 FROM rating.source_statistic_head AS head
                    WHERE head.route = input.route AND head.subject_id = input.subject_id
                      AND head.source = input.source)
       ELSE retained."seekOrder" IS NULL
         OR EXISTS (SELECT 1 FROM rating.source_statistic_head AS head
                    WHERE head.route = input.route AND head.subject_id = input.subject_id
                      AND head.source = input.source AND head.last_seek_order = 0)
         OR EXISTS (SELECT 1 FROM rating.source_statistic AS statistic
                    WHERE statistic.route = input.route AND statistic.subject_id = input.subject_id
                      AND statistic.source = input.source
                      AND statistic.observation_digest IS DISTINCT FROM retained.digest)
       END AS "inconsistent"
FROM input LEFT JOIN retained ON true;
