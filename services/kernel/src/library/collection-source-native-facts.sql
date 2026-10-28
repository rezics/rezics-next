-- Every gated branch applies its indexed raw limit before UNION/sort. No state or parent filter precedes it.
SELECT subject_id::text AS "storedSubjectId", fact_id::text AS "factId"
FROM (
  (SELECT subject_id, subject_id AS fact_id FROM library.entry
   WHERE $6::text = 'entry' AND route = $1 AND account_id = $2
     AND subject_id > COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
   ORDER BY subject_id LIMIT $5)
  UNION ALL
  (SELECT subject_id, copy_id FROM library.copy
   WHERE $6 = 'copy' AND route = $1 AND account_id = $2
     AND (subject_id, copy_id) > (COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, copy_id LIMIT $5)
  UNION ALL
  (SELECT subject_id, session_id FROM library.progress_session
   WHERE $6 = 'session' AND route = $1 AND account_id = $2
     AND (subject_id, session_id) > (COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE($4, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, session_id LIMIT $5)
  UNION ALL
  (SELECT subject_id, assignment_id FROM library.label_assignment
   WHERE $6 = 'label' AND route = $1 AND account_id = $2 AND slot_no IS NOT NULL
     AND (subject_id, assignment_id) > (COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE($4, '00000000-0000-0000-0000-000000000000'::uuid))
   ORDER BY subject_id, assignment_id LIMIT $5)
) AS raw ORDER BY subject_id, fact_id;
