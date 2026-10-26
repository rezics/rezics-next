-- One exact-key statement returns either the tombstone transition or an existing
-- tombstone for the author. A caller with no matching row sees no result.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :author_id::uuid AS author_id
), changed AS (
  UPDATE content.authored_field AS field
  SET availability = 'erased', body = NULL
  FROM input i
  WHERE field.route = i.route
    AND field.id = i.id
    AND field.author_account_id = i.author_id
    AND field.availability = 'available'
  RETURNING field.id, field.subject, field.author_account_id, TRUE AS changed
)
SELECT id, subject, author_account_id, changed FROM changed
UNION ALL
SELECT field.id, field.subject, field.author_account_id, FALSE AS changed
FROM content.authored_field AS field
JOIN input i ON field.route = i.route AND field.id = i.id
WHERE field.author_account_id = i.author_id
  AND field.availability = 'erased'
  AND NOT EXISTS (SELECT 1 FROM changed);
