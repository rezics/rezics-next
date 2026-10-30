INSERT INTO community.realm_revision
  (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, board_scheme_id, created_at, author, presentation)
VALUES (:route::integer, :id::uuid, :revision::uuid, :predecessor::uuid,
        :title::text, :summary::text, :visibility::text, :context::uuid, :scheme::uuid, :at::timestamptz, :author::uuid, :presentation::jsonb);
