UPDATE community.space SET head_revision_id = :revision::uuid
WHERE route = :route::integer AND space_id = :id::uuid
  AND head_revision_id = :expected::uuid AND state = 'active'
RETURNING space_id;
