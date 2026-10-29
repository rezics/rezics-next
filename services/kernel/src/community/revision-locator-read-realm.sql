SELECT author FROM community.realm_revision
WHERE route = :route::integer AND realm_id = :owner_id::uuid AND revision_id = :revision_id::uuid;
