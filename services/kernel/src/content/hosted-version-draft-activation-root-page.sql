SELECT parent_id,
  root_id,
  next_position::text AS next_position
FROM content.hosted_version_builder_sibling_root
WHERE route = $1
  AND catalogue_id = $2
  AND input_id = $3
  AND (
    CASE
      WHEN $4::boolean THEN parent_id IS NOT NULL AND parent_id > $5
      ELSE true
    END
  )
ORDER BY parent_id NULLS FIRST
LIMIT $6
