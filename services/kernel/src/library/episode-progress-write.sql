WITH removed AS (
 DELETE FROM library.progress_episode
 WHERE route=:route AND session_id=:session_id
   AND (:clear::boolean OR episode_subject_id=ANY(:remove::uuid[])) RETURNING 1
), added AS (
 INSERT INTO library.progress_episode(route, session_id, episode_subject_id, added_at)
 SELECT :route, :session_id, id, :time::timestamptz FROM unnest(:add::uuid[]) AS ids(id)
 ON CONFLICT DO NOTHING RETURNING 1
)
UPDATE library.progress_session SET episode_completed_count=episode_completed_count
 + (SELECT count(*)::integer FROM added) - (SELECT count(*)::integer FROM removed)
WHERE route=:route AND session_id=:session_id
RETURNING episode_completed_count AS count;
