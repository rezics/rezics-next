SELECT board_id, realm_id, visibility, purpose, security_revision::text, created_at::text
FROM content.board
WHERE route = :route::integer AND board_id = :id::uuid;
