SELECT notebook_id, owner_account_id, subject_id, title, structure_revision_id, created_at,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_key
FROM content.knowledge_notebook
WHERE route=:route AND owner_account_id=:owner_account_id
  AND (created_at < :after_created_at OR (created_at = :after_created_at AND notebook_id > :after_notebook_id))
ORDER BY created_at DESC, notebook_id
LIMIT :limit;
