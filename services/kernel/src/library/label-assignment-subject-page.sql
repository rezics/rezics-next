SELECT assignment_id AS id, label_id AS "labelId", subject_id AS "subjectId", revision,
       slot_no AS "slotNo"
FROM library.label_assignment
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND slot_no IS NOT NULL
ORDER BY assignment_id LIMIT 32;
