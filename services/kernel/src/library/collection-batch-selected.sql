WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :collection_id::uuid AS collection_id)
SELECT member.collection_id AS "collectionId", member.member_id AS id, member.subject_id AS "subjectId",
       member.note, member.ordinal_key AS "ordinalKey", member.added_at::text AS "addedAt"
FROM input CROSS JOIN unnest(:ids::uuid[]) requested(id)
CROSS JOIN LATERAL (
  SELECT m.collection_id, m.member_id, m.subject_id, m.note, m.ordinal_key, m.added_at
  FROM library.collection_member m
  WHERE m.route=input.route AND m.collection_id=input.collection_id AND m.member_id=requested.id
    AND m.deletion_id IS NULL
  FOR UPDATE
) member
ORDER BY member.ordinal_key COLLATE "C", member.member_id;
