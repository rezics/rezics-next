SELECT board_id, realm_id, security_revision::text
FROM content.board
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND visibility = 'published' AND created_at <= :at::timestamptz;
