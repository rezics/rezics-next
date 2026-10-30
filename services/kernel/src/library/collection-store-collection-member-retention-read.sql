SELECT member_id AS "memberId", subject_id AS "subjectId", note, deleted_ordinal_key AS "ordinalKey",
       added_at::text AS "addedAt", deletion_id AS "deletionId", deletion_revision AS "deletionRevision",
       deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM library.collection_member
WHERE route=:route AND collection_id=:collection_id AND member_id=:member_id AND deletion_id IS NOT NULL;
