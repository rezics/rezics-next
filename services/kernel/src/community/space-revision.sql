INSERT INTO community.space_revision
  (route, space_id, revision_id, predecessor, title, summary, created_at, author)
VALUES (:route::integer, :id::uuid, :revision::uuid, :predecessor::nullable(uuid),
        :title::text, :summary::text, :at::timestamptz, :author::uuid);
