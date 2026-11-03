WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :source::text AS source
), retained AS (
  SELECT head.digest, observation.source_alias AS "sourceAlias",
         observation.source_record_id AS "sourceRecordId", observation.as_of::text AS "asOf",
         observation.payload_version AS "payloadVersion",
         observation.local_order::text AS "nativeOrder",
         head.last_order::text AS "lastOrder",
         observation.local_order IS NULL AS legacy
  FROM rating.source_statistic_head AS head
  JOIN rating.source_statistic_observation AS observation
    ON observation.route = head.route AND observation.subject_id = head.subject_id
   AND observation.source = head.source AND observation.digest = head.digest
  CROSS JOIN input
  WHERE head.route = input.route AND head.subject_id = input.subject_id AND head.source = input.source
), legacy AS (
  SELECT NULL::text AS digest, statistic.source_alias AS "sourceAlias",
         statistic.source_record_id AS "sourceRecordId", statistic.as_of::text AS "asOf",
         1::smallint AS "payloadVersion", NULL::text AS "nativeOrder",
         '0'::text AS "lastOrder", true AS legacy
  FROM rating.source_statistic AS statistic
  CROSS JOIN input
  WHERE statistic.route = input.route AND statistic.subject_id = input.subject_id
    AND statistic.source = input.source
    AND NOT EXISTS (SELECT 1 FROM rating.source_statistic_head AS head
                    WHERE head.route = input.route AND head.subject_id = input.subject_id
                      AND head.source = input.source)
  LIMIT 1
)
SELECT * FROM retained
UNION ALL
SELECT * FROM legacy;
