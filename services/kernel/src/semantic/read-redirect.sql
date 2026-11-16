SELECT head.target::text AS target FROM (
  SELECT target FROM semantic.redirect
  WHERE route = :route::integer AND subject_id = :subject_id::uuid
  ORDER BY sequence DESC LIMIT 1
) head WHERE head.target IS NOT NULL;
