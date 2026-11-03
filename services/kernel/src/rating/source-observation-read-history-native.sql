SELECT digest, source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
       as_of::text AS "asOf", payload_version AS "payloadVersion",
       local_order::text AS "nativeOrder", false AS legacy
FROM rating.source_statistic_observation
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND source = :source::text AND local_order IS NOT NULL
  AND (:cursor_order::bigint IS NULL OR local_order < :cursor_order::bigint)
ORDER BY local_order DESC
LIMIT 2;
