SELECT digest, source_alias AS "sourceAlias", source_record_id AS "sourceRecordId",
       as_of::text AS "asOf", payload_version AS "payloadVersion",
       local_order::text AS "nativeOrder", local_order IS NULL AS legacy
FROM rating.source_statistic_observation
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND source = :source::text AND digest = :digest::text;
