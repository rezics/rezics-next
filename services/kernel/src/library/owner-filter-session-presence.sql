SELECT subject_id AS "subjectId"
FROM library.progress_session
WHERE route = :route AND account_id = :account_id
  AND subject_id = :subject_id AND session_id = :session_id;
