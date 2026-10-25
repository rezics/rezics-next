INSERT INTO content.revision
  (route, thread_id, post_id, revision_id, body, body_sha256, search_text,
   licence, subject_ids, board_id, availability, recorded_transaction_id)
VALUES
  (:route::integer, :thread_id::uuid, :post_id::uuid, :revision_id::uuid, :body::nullable(bytea),
   :body_sha256::bytea, :search_text::nullable(text), :licence::text, :subject_ids::uuid[],
   :board_id::uuid, :availability::text, :transaction_id::uuid);
