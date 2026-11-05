SELECT episode_completed_count AS count FROM library.progress_session
WHERE route=:route AND session_id=:session_id;
