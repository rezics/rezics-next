SELECT revision, kind, release
FROM semantic.revision
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND revision = :revision::integer;
