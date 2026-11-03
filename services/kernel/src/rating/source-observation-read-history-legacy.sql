SELECT digest, source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
       as_of::text AS "asOf", payload_version AS "payloadVersion",
       NULL::text AS "nativeOrder", true AS legacy
FROM rating.source_statistic_observation
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND source = :source::text AND local_order IS NULL
  AND (:cursor_digest::text IS NULL OR digest < :cursor_digest::text)
ORDER BY digest DESC
LIMIT 2;
