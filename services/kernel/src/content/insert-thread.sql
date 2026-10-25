INSERT INTO content.thread
  (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id)
VALUES
  (:route::integer, :thread_id::uuid, :author_account_id::uuid, :board_id::uuid,
   :title::text, :visibility::text, :security_revision::bigint, :transaction_id::uuid);
