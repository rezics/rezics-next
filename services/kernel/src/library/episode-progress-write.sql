WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :session_id::uuid AS session_id, :clear::boolean AS clear,
        :remove::uuid[] AS remove_ids, :add::uuid[] AS add_ids, :time::timestamptz AS added_at
), removed AS (
 DELETE FROM library.progress_episode fact USING input
 WHERE fact.route=input.route AND fact.session_id=input.session_id
   AND (input.clear OR fact.episode_subject_id=ANY(input.remove_ids)) RETURNING 1
), added AS (
 INSERT INTO library.progress_episode(route, session_id, episode_subject_id, added_at)
 SELECT input.route, input.session_id, ids.id, input.added_at FROM input, unnest(input.add_ids) AS ids(id)
 ON CONFLICT DO NOTHING RETURNING 1
)
UPDATE library.progress_session session SET episode_completed_count=episode_completed_count
 + (SELECT count(*)::integer FROM added) - (SELECT count(*)::integer FROM removed)
FROM input WHERE session.route=input.route AND session.session_id=input.session_id
RETURNING episode_completed_count AS count;
