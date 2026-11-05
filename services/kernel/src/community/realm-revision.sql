INSERT INTO community.realm_revision
  (route, realm_id, revision_id, predecessor, title, summary, visibility, context_id, created_at, author, votes, presentation)
VALUES (:route::integer, :id::uuid, :revision::uuid, :predecessor::nullable(uuid),
        :title::text, :summary::text, :visibility::text, :context::uuid, :at::timestamptz, :author::uuid, :votes::jsonb, :presentation::jsonb);
