SELECT subject_id AS "subjectId"
FROM library.entry
WHERE route = :route AND account_id = :account_id AND subject_id = :subject_id
  AND state IS NOT NULL;
