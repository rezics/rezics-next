SELECT 'board'::text AS kind, board_id AS id, NULL::uuid AS parent_id,
  NULL::uuid AS thread_id, NULL::uuid AS board_id, realm_id, purpose, visibility, security_revision::text, 'available'::text AS availability
  FROM content.board WHERE route=:route::integer AND board_id=:id::uuid;
