SELECT probed.revision, probed.source
FROM unnest(:revisions::integer[]) AS wanted(revision)
JOIN LATERAL (
  SELECT revision, source FROM semantic.revision
  WHERE route = :route::integer AND subject_id = :subject_id::uuid AND revision = wanted.revision
  OFFSET 0
  LIMIT 1
) probed ON true;
