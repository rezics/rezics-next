-- The native primary-key range also retains unreserved and hidden assignments.
-- label_id is the actual native row key here, never a manufactured assignment witness.
SELECT subject_id::text AS "storedSubjectId", label_id::text AS "factId"
FROM library.label_assignment
WHERE route = :route AND account_id = :account_id
  AND (subject_id, label_id) > (
    COALESCE(:after_subject::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(:after_fact::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid)
  )
ORDER BY subject_id, label_id
LIMIT :limit;
