WITH input AS (
  SELECT :after_ordinal_key::nullable(text) AS after_ordinal_key,
         :after_member_id::nullable(uuid) AS after_member_id
)
SELECT collection_id AS "collectionId", member_id AS id, subject_id AS "subjectId", note, ordinal_key AS "ordinalKey",
       added_at::text AS "addedAt"
FROM library.collection_member
  CROSS JOIN input
WHERE route = :route AND collection_id = :collection_id
  AND deletion_id IS NULL
  AND (input.after_ordinal_key IS NULL OR (ordinal_key, member_id) > (input.after_ordinal_key, input.after_member_id))
ORDER BY ordinal_key, member_id
LIMIT :limit;
