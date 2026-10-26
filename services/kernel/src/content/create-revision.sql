INSERT INTO content.revision
  (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
   subject_ids, board_id, availability, recorded_transaction_id, recorded_at, media_ids, vote_citation)
VALUES
  (:route::integer, :thread_id::uuid, :post_id::uuid, :revision_id::uuid, :body::bytea,
   :body_sha256::bytea, :search_text::text, :licence::text, :subject_ids::uuid[],
   :board_id::uuid, 'available', :transaction_id::uuid, :at::timestamptz, :media_ids::uuid[],
   :vote_citation::nullable(jsonb));
