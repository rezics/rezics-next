INSERT INTO content.thread
  (route, thread_id, author_account_id, board_id, kind, review_subject_id, title, visibility, security_revision,
   recorded_transaction_id, first_post_id, created_at, availability)
VALUES
  (:route::integer, :thread_id::uuid, :author_id::uuid, :board_id::uuid, :kind::text,
   :review_subject_id::nullable(uuid), :title::text, :visibility::text, 1, :transaction_id::uuid,
   :first_post_id::uuid, :at::timestamptz, 'available');
