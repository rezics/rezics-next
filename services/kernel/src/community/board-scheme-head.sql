UPDATE community.realm SET head_revision_id = :revision::uuid, board_scheme_id = :scheme::uuid
WHERE route = :route::integer AND realm_id = :id::uuid
  AND head_revision_id = :expected::uuid AND state = 'active'
RETURNING realm_id;
