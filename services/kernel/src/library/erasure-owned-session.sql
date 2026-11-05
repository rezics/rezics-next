WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :after_id::nullable(uuid) AS after_id
)
SELECT session_id AS id FROM library.progress_session, input
WHERE progress_session.route=input.route AND progress_session.account_id=input.account_id
  AND (input.after_id IS NULL OR session_id>input.after_id)
ORDER BY session_id LIMIT 1;
