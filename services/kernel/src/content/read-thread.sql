SELECT thread_id, author_account_id, board_id, first_post_id, kind, review_subject_id, visibility, availability,
       security_revision::text, created_at::text, recorded_transaction_id,
       xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here
FROM content.thread
WHERE route = :route::integer AND thread_id = :id::uuid;
