WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route,
         :owner_account_id::uuid AS owner_account_id,
         :after_created_at::timestamptz AS after_created_at,
         :after_notebook_id::uuid AS after_notebook_id,
         :limit::integer AS page_limit
)
SELECT n.notebook_id, n.owner_account_id, n.subject_id, n.title, n.structure_revision_id, n.created_at,
       to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
FROM content.knowledge_notebook n
CROSS JOIN input
WHERE n.route=input.route AND n.owner_account_id=input.owner_account_id
  AND (n.created_at < input.after_created_at OR
       (n.created_at = input.after_created_at AND n.notebook_id > input.after_notebook_id))
ORDER BY n.created_at DESC, n.notebook_id
LIMIT (SELECT page_limit FROM input);
