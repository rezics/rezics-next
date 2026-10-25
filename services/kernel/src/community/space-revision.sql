INSERT INTO community.space_revision
  (route, space_id, revision_id, predecessor, address, title, summary, created_at, author)
VALUES (:route::integer, :id::uuid, :revision::uuid, :predecessor::nullable(uuid), :address::nullable(text),
        :title::text, :summary::text, :at::timestamptz, :author::uuid);
