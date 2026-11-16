SELECT 1 FROM (
  SELECT target FROM semantic.redirect WHERE route=$1 AND subject_id=$2 ORDER BY sequence DESC LIMIT 1
) head WHERE head.target IS NOT NULL;
