INSERT INTO community.space (route, space_id, state, head_revision_id, created_at, creator)
VALUES (:route::integer, :id::uuid, 'active', :revision::uuid, :at::timestamptz, :creator::uuid);
