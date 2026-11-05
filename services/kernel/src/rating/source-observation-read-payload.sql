SELECT digest, payload, payload_version AS "payloadVersion"
FROM rating.source_statistic_observation
WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND source = :source::text AND digest = ANY(:digests::text[])
ORDER BY digest;
