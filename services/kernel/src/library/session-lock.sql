SELECT session_id
FROM library.progress_session
WHERE route = :route AND session_id = :session_id
FOR UPDATE;
