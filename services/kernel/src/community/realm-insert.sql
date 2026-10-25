INSERT INTO community.realm (route, realm_id, space_id, state, visibility, context_id, head_revision_id, created_at, creator)
VALUES (:route::integer, :id::uuid, :space::uuid, 'active', :visibility::text, :context::uuid, :revision::uuid, :at::timestamptz, :creator::uuid);
