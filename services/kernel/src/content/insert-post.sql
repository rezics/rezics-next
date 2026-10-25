INSERT INTO content.post
  (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id,
   visibility, security_revision, recorded_transaction_id)
VALUES
  (:route::integer, :thread_id::uuid, :post_id::uuid, :reply_to_post_id::nullable(uuid), :author_account_id::uuid,
   :head_revision_id::uuid, :visibility::text, :security_revision::bigint, :transaction_id::uuid);
