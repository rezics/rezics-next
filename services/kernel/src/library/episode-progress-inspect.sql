SELECT episode_subject_id AS id FROM library.progress_episode
WHERE route=:route AND session_id=:session_id AND episode_subject_id=ANY(:ids::uuid[]);
