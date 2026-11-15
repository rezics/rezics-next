WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,:account_id::uuid AS account_id,:after_id::nullable(uuid) AS after_id
)
SELECT selected.notebook_id,selected.structure_revision_id
FROM input i CROSS JOIN LATERAL (
  (SELECT notebook_id,structure_revision_id FROM content.knowledge_notebook
   WHERE route=i.route AND owner_account_id=i.account_id AND i.after_id IS NULL
   ORDER BY route,owner_account_id,notebook_id LIMIT 1)
  UNION ALL
  (SELECT notebook_id,structure_revision_id FROM content.knowledge_notebook
   WHERE route=i.route AND owner_account_id=i.account_id AND i.after_id IS NOT NULL AND notebook_id>i.after_id
   ORDER BY route,owner_account_id,notebook_id LIMIT 1)
) selected;
