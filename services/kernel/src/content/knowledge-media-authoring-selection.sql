WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id, :revision_id::uuid AS revision_id
)
SELECT notebook.owner_account_id,notebook.subject_id,revision.subject_ids,revision.media_ids,
       revision.body_sha256,NULL::uuid AS publication_id,document.lifecycle_generation::text
FROM input i
JOIN content.knowledge_document document ON document.route=i.route AND document.document_id=i.document_id
JOIN content.knowledge_notebook notebook ON notebook.route=document.route AND notebook.notebook_id=document.notebook_id
JOIN content.knowledge_revision revision
  ON revision.route=document.route AND revision.document_id=document.document_id AND revision.revision_id=i.revision_id
WHERE content.knowledge_document_eligible(document.route,document.document_id);
