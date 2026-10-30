UPDATE library.collection_member
SET note = :note::nullable(text), transaction_id = :transaction_id
WHERE route = :route AND collection_id = :collection_id AND member_id = :member_id AND deletion_id IS NULL
RETURNING collection_id AS "collectionId", member_id AS id, subject_id AS "subjectId", note, ordinal_key AS "ordinalKey",
          added_at::text AS "addedAt";
