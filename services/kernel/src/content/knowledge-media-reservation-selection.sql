WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id, :notebook_id::uuid AS notebook_id
)
SELECT notebook.owner_account_id,notebook.notebook_id,document.lifecycle_generation::text
FROM input i
JOIN content.knowledge_document document
  ON document.route=i.route AND document.document_id=i.document_id AND document.notebook_id=i.notebook_id
JOIN content.knowledge_notebook notebook ON notebook.route=document.route AND notebook.notebook_id=document.notebook_id
WHERE NOT document.account_erased AND NOT notebook.account_erased
  AND content.knowledge_document_eligible(document.route,document.document_id);
