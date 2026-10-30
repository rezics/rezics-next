SELECT collection_id AS "collectionId", member_id AS id, subject_id AS "subjectId", note, ordinal_key AS "ordinalKey",
       added_at::text AS "addedAt"
FROM library.collection_member
WHERE route = :route AND collection_id = :collection_id AND member_id = :member_id AND deletion_id IS NULL;
