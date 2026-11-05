SELECT page_data, page_digest
FROM semantic.public_filter_projection_replay
WHERE partition_no = :partition_no::integer AND bootstrap = :bootstrap::uuid
  AND execution = :execution::text AND predecessor = :predecessor::text
  AND route = :route::integer AND subject_id = :subject_id::uuid
  AND request_digest = :request_digest::text;
