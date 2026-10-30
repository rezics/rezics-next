INSERT INTO content.realm_discovery_contribution
  (route, thread_id, board_id, realm_id, space_id, realm_epoch, creation_day, created_at)
SELECT t.route, t.thread_id, t.board_id, :realm_id::uuid, :space_id::uuid,
       :realm_epoch::bigint, (:at::timestamptz AT TIME ZONE 'UTC')::date, :at::timestamptz
FROM content.thread t
JOIN content.post p ON p.route = t.route AND p.thread_id = t.thread_id AND p.post_id = t.first_post_id
WHERE t.route = :route::integer AND t.thread_id = :thread_id::uuid
  AND t.board_id = :board_id::uuid AND t.kind = 'discussion'
  AND t.visibility = 'published' AND t.availability = 'available'
  AND p.visibility = 'published' AND p.availability = 'available'
  AND t.created_at = :at::timestamptz AND p.created_at = :at::timestamptz
RETURNING route, thread_id, board_id, realm_id, space_id, realm_epoch::text,
          creation_day::text, source_version::text, contributing;
