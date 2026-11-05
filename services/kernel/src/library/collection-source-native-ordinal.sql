-- Raw occurrence order includes retained deletion episodes. Filtering never moves this frontier.
SELECT member_id::text AS "memberId", subject_id::text AS "subjectId", ordinal_key AS "ordinalKey",
       deletion_id::text AS "deletionId", deleted_at::text AS "deletedAt",
       member_revision::text AS "memberRevision"
FROM library.collection_member
WHERE route=$1 AND collection_id=$2
  AND (ordinal_key,member_id) > ($3::text COLLATE "C",$4::uuid)
ORDER BY ordinal_key,member_id
LIMIT $5;
