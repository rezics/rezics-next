SELECT post_id FROM content.revision WHERE route = :route::integer AND revision_id = :id::uuid AND thread_id = :thread_id::uuid;
