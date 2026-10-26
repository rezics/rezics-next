SELECT revision, kind, release, source FROM semantic.revision WHERE route = :route::integer AND subject_id = :subject_id::uuid
  AND revision < :before::integer ORDER BY revision DESC LIMIT :page_limit::integer;
