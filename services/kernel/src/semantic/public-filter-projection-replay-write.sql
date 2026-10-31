INSERT INTO semantic.public_filter_projection_replay
  (partition_no, bootstrap, execution, predecessor, route, subject_id, request_digest, page_data, page_digest)
VALUES
  (:partition_no::integer, :bootstrap::uuid, :execution::text, :predecessor::text, :route::integer,
   :subject_id::uuid, :request_digest::text, :page_data::text, :page_digest::text)
ON CONFLICT (partition_no, bootstrap, execution, predecessor, route, subject_id, request_digest) DO NOTHING
RETURNING page_data, page_digest;
