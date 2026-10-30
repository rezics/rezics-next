SELECT subject_id AS "subjectId"
FROM library.copy
WHERE route = :route AND account_id = :account_id
  AND subject_id = :subject_id AND copy_id = :copy_id AND deletion_id IS NULL;
