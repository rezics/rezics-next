SELECT subject_id AS "subjectId", session_id AS "sessionId", state AS lifecycle,
       mode, unit, library_profile_pin AS "libraryProfilePin"
FROM library.progress_session
WHERE state <> 'retired' AND route = :route AND account_id = :account_id
  AND subject_id = :subject_id AND session_id = :session_id;
