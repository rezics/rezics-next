SELECT author FROM community.space_revision
WHERE route = :route::integer AND space_id = :owner_id::uuid AND revision_id = :revision_id::uuid;
