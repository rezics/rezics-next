INSERT INTO content.post
  (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id,
   visibility, security_revision, recorded_transaction_id, created_at, availability)
VALUES
  (:route::integer, :thread_id::uuid, :post_id::uuid, :parent_id::nullable(uuid), :author_id::uuid,
   :revision_id::uuid, :visibility::text, 1, :transaction_id::uuid, :at::timestamptz, 'available');
