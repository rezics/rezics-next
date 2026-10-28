-- Every gated branch applies its indexed raw limit before UNION/sort. No state or parent filter precedes it.
SELECT subject_id::text AS "storedSubjectId", fact_id::text AS "factId"
FROM (
  (SELECT subject_id, subject_id AS fact_id FROM library.entry
   WHERE :driver::text = 'entry' AND route = :route AND account_id = :account_id
     AND subject_id > COALESCE(:after_subject::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
   ORDER BY subject_id LIMIT :limit)
  UNION ALL
  (SELECT subject_id, copy_id FROM library.copy
   WHERE :driver = 'copy' AND route = :route AND account_id = :account_id
     AND (subject_id, copy_id) > (COALESCE(:after_subject, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(:after_fact::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, copy_id LIMIT :limit)
  UNION ALL
  (SELECT subject_id, session_id FROM library.progress_session
   WHERE :driver = 'session' AND route = :route AND account_id = :account_id
     AND (subject_id, session_id) > (COALESCE(:after_subject, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(:after_fact, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, session_id LIMIT :limit)
  UNION ALL
  (SELECT subject_id, assignment_id FROM library.label_assignment
   WHERE :driver = 'label' AND route = :route AND account_id = :account_id AND slot_no IS NOT NULL
     AND (subject_id, assignment_id) > (COALESCE(:after_subject, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(:after_fact, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, assignment_id LIMIT :limit)
) AS raw ORDER BY subject_id, fact_id;
