WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :member_id::uuid AS member_id,
         :subject_id::uuid AS subject_id, :note::nullable(text) AS note, :ordinal_key::text AS ordinal_key,
         :time::timestamptz AS time, :transaction_id::uuid AS transaction_id
), parent AS (
  UPDATE library.collection AS collection
  SET member_count = member_count + 1, source_generation = source_generation + 1,
      updated_at = input.time, transaction_id = input.transaction_id
  FROM input
  WHERE collection.route = input.route AND collection.collection_id = input.collection_id AND collection.member_count < 5000
  RETURNING collection.route, collection.collection_id
)
INSERT INTO library.collection_member
  (route, collection_id, member_id, subject_id, note, ordinal_key, added_at, transaction_id)
SELECT input.route, parent.collection_id, input.member_id, input.subject_id, input.note, input.ordinal_key,
       input.time, input.transaction_id
FROM parent CROSS JOIN input
RETURNING collection_id AS "collectionId", member_id AS id, subject_id AS "subjectId", note, ordinal_key AS "ordinalKey",
          added_at::text AS "addedAt";
