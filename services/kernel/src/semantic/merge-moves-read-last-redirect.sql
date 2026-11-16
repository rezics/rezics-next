SELECT head.sequence, head.target::text FROM (
  SELECT sequence, target FROM semantic.redirect
  WHERE route = :route::integer AND subject_id = :subject_id::uuid
  ORDER BY sequence DESC LIMIT 1
) head WHERE head.target IS NOT NULL;
