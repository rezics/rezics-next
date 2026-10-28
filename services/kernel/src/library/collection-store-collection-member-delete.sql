WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :member_id::uuid AS member_id, :time::timestamptz AS time, :transaction_id::uuid AS transaction_id
), deleted AS (
  DELETE FROM library.collection_member AS member
  USING input
  WHERE member.route = input.route AND member.collection_id = input.collection_id AND member.member_id = input.member_id
  RETURNING member.route, member.collection_id, member.member_id, member.subject_id, member.note,
            member.ordinal_key, member.added_at
), parent AS (
  UPDATE library.collection AS collection
  SET member_count = member_count - 1, source_generation = source_generation + 1,
      updated_at = input.time, transaction_id = input.transaction_id
  FROM input
  WHERE collection.route = input.route AND collection.collection_id = input.collection_id
    AND collection.member_count > 0
    AND EXISTS (SELECT 1 FROM deleted)
  RETURNING collection.route, collection.collection_id
)
SELECT deleted.collection_id AS "collectionId", deleted.member_id AS id, deleted.subject_id AS "subjectId",
       deleted.note, deleted.ordinal_key AS "ordinalKey", deleted.added_at::text AS "addedAt"
FROM deleted JOIN parent USING (route, collection_id);
