-- Only immutable opening-review identity and restoration eligibility; no revision or bytes.
-- The post and its containing thread share a route. Both probes use complete keys.
SELECT t.thread_id, t.board_id, t.review_subject_id AS subject_id
FROM content.post p
JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
WHERE p.route = :route::integer AND p.post_id = :post_id::uuid
  AND p.author_account_id = :author_id::uuid AND t.author_account_id = p.author_account_id
  AND t.first_post_id = p.post_id AND t.kind = 'review'
  AND t.availability = 'available' AND t.visibility <> 'taken_down'
  AND p.availability = 'erased' AND p.deleted_at > :at::timestamptz - interval '30 days'
  AND p.purge_started_at IS NULL AND NOT p.purge_completed;
