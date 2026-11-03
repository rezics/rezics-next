WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :session_id::uuid AS session_id, :after::nullable(uuid) AS after_id
)
SELECT fact.episode_subject_id AS id, fact.added_at::text AS "addedAt"
FROM library.progress_episode fact, input
WHERE fact.route=input.route AND fact.session_id=input.session_id
  AND (input.after_id IS NULL OR fact.episode_subject_id>input.after_id)
ORDER BY fact.episode_subject_id LIMIT :limit;
