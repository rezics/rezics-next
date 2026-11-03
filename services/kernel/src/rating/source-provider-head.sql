SELECT head.digest, head.last_order::text AS "lastOrder",
       observation.local_order::text AS "nativeOrder",
       observation.payload_version AS "payloadVersion",
       observation.source_alias AS "sourceAlias",
       observation.source_record_id AS "sourceRecordId", observation.as_of::text AS "asOf",
       observation.payload
FROM rating.source_statistic_head AS head
JOIN rating.source_statistic_observation AS observation
  ON observation.route = head.route AND observation.subject_id = head.subject_id
 AND observation.source = head.source AND observation.digest = head.digest
WHERE head.route = :route::integer AND head.subject_id = :subject_id::uuid AND head.source = :source::text;
