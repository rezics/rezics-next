SELECT p.post_id, p.thread_id, p.reply_to_post_id, p.author_account_id, p.head_revision_id,
       p.visibility, p.availability, p.security_revision::text, p.created_at::text,
       p.recorded_transaction_id, p.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
       r.licence, r.subject_ids, r.board_id, r.media_ids, r.availability AS revision_availability
FROM content.post p
JOIN LATERAL (
  SELECT r.licence, r.subject_ids, r.board_id, r.media_ids, r.availability
  FROM content.revision r
  WHERE r.route = p.route AND r.revision_id = p.head_revision_id
    AND r.thread_id = p.thread_id AND r.post_id = p.post_id
  LIMIT 1
) r ON true
WHERE p.route = :route::integer AND p.post_id = :id::uuid;
