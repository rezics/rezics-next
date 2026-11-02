SELECT ordinal::text AS ordinal,
       subject_id::text AS "subjectId",
       member_id::text AS "memberId",
       state,
       reason,
       resulting_member_id::text AS "resultingMemberId",
       collection_id::text AS "collectionId",
       target, receipt, evidence, source_digest AS "sourceDigest"
FROM library.bulk_target
WHERE route = :route::integer
  AND operation_id = :operation_id::uuid
  AND account_id = :account_id::uuid
  AND state = :state::text
  AND ordinal > :after::bigint
ORDER BY bulk_target.ordinal ASC
LIMIT :page_limit::integer;
