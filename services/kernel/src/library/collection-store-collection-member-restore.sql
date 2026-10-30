WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :member_id::uuid AS member_id, :deletion_id::uuid AS deletion_id,
         :expected_revision::bigint AS expected_revision, :time::timestamptz AS time,
         :transaction_id::uuid AS transaction_id
), parent AS (
  UPDATE library.collection AS collection
  SET member_count = member_count + 1, source_generation = source_generation + 1,
      revision = revision + 1, updated_at = input.time, transaction_id = input.transaction_id
  FROM input
  WHERE collection.route = input.route AND collection.collection_id = input.collection_id
    AND collection.state = 'active' AND collection.member_count < 5000
    AND EXISTS (SELECT 1 FROM library.collection_member m WHERE m.route=input.route AND m.collection_id=input.collection_id
      AND m.member_id=input.member_id AND m.deletion_id=input.deletion_id
      AND m.deletion_revision=input.expected_revision AND m.purge_after > input.time)
    AND NOT EXISTS (SELECT 1 FROM library.collection_member occupied WHERE occupied.route=input.route
      AND occupied.collection_id=input.collection_id AND occupied.deletion_id IS NULL
      AND occupied.member_id<>input.member_id AND occupied.ordinal_key=(SELECT saved.deleted_ordinal_key
        FROM library.collection_member saved WHERE saved.route=input.route AND saved.collection_id=input.collection_id
          AND saved.member_id=input.member_id AND saved.deletion_id=input.deletion_id))
  RETURNING collection.route, collection.collection_id
), restored AS (
  UPDATE library.collection_member AS member
  SET ordinal_key=member.deleted_ordinal_key, deleted_ordinal_key=NULL,
      deletion_id=NULL, deletion_revision=NULL, deleted_at=NULL, purge_after=NULL,
      member_revision=member_revision+1, transaction_id=input.transaction_id
  FROM input JOIN parent USING(route, collection_id)
  WHERE member.route=input.route AND member.collection_id=input.collection_id AND member.member_id=input.member_id
    AND member.deletion_id=input.deletion_id AND member.deletion_revision=input.expected_revision
    AND member.purge_after > input.time
  RETURNING member.collection_id, member.member_id, member.subject_id, member.note, member.ordinal_key, member.added_at
)
SELECT collection_id AS "collectionId", member_id AS id, subject_id AS "subjectId", note,
       ordinal_key AS "ordinalKey", added_at::text AS "addedAt"
FROM restored;
