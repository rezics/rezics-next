INSERT INTO content.board
  (route, board_id, realm_id, subject_id, title, visibility, security_revision, purpose,
   recorded_transaction_id, created_at)
VALUES
  (:route::integer, :board_id::uuid, :realm_id::nullable(uuid), :subject_id::uuid, :title::text,
   :visibility::text, 1, :purpose::text, :transaction_id::uuid, :at::timestamptz);
