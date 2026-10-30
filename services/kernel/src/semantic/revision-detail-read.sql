SELECT revision, kind, release, term_changes, term_support
FROM semantic.revision
WHERE route = :route::integer AND subject_id = :subject_id::uuid AND revision = :revision::integer;
