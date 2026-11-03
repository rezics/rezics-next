SELECT episode_subject_id AS id, added_at::text AS "addedAt"
FROM library.progress_episode
WHERE route=:route AND session_id=:session_id
  AND (:after::nullable(uuid) IS NULL OR episode_subject_id>:after::nullable(uuid))
ORDER BY episode_subject_id LIMIT :limit;
