WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :collection_id::uuid AS collection_id,
         :member_id::uuid AS member_id, :expected_revision::bigint AS expected_revision,
         :deletion_id::uuid AS deletion_id, :time::timestamptz AS time, :transaction_id::uuid AS transaction_id
), parent AS (
  UPDATE library.collection AS collection
  SET member_count = member_count - 1, source_generation = source_generation + 1,
      revision = revision + 1, updated_at = input.time, transaction_id = input.transaction_id
  FROM input
  WHERE collection.route = input.route AND collection.collection_id = input.collection_id
    AND collection.state = 'active' AND collection.revision = input.expected_revision AND collection.member_count > 0
    AND EXISTS (SELECT 1 FROM library.collection_member m WHERE m.route=input.route AND m.collection_id=input.collection_id
      AND m.member_id=input.member_id AND m.deletion_id IS NULL)
  RETURNING collection.route, collection.collection_id, collection.revision
), deleted AS (
  UPDATE library.collection_member AS member
  SET deletion_id = input.deletion_id, deletion_revision = parent.revision, deleted_at = input.time,
      purge_after = input.time + interval '720 hours', member_revision = member_revision + 1,
      deleted_ordinal_key = member.ordinal_key, ordinal_key = '~' || member.member_id::text,
      transaction_id = input.transaction_id
  FROM input JOIN parent USING (route, collection_id)
  WHERE member.route = input.route AND member.collection_id = input.collection_id AND member.member_id = input.member_id
    AND member.deletion_id IS NULL
  RETURNING member.route, member.collection_id, member.member_id, member.subject_id, member.note,
            member.deleted_ordinal_key AS ordinal_key, member.added_at, member.deletion_id, member.deletion_revision
)
SELECT deleted.collection_id AS "collectionId", deleted.member_id AS id, deleted.subject_id AS "subjectId",
       deleted.note, deleted.ordinal_key AS "ordinalKey", deleted.added_at::text AS "addedAt",
       deleted.deletion_id AS "deletionId", deleted.deletion_revision AS revision
FROM deleted;
