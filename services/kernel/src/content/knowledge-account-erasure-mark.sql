WITH input AS MATERIALIZED (
  SELECT :route::integer AS route,:notebook_id::uuid AS notebook_id,:document_id::uuid AS document_id
)
UPDATE content.knowledge_document document
SET retained_public_generation=document.lifecycle_generation,account_erased=true
FROM input i
WHERE document.route=i.route AND document.notebook_id=i.notebook_id AND document.document_id=i.document_id
  AND content.knowledge_document_eligible(document.route,document.document_id)
  AND EXISTS (
    SELECT 1 FROM content.knowledge_publication publication
    JOIN content.knowledge_publication_selection selection
      ON selection.route=publication.route AND selection.document_id=publication.document_id
     AND selection.lifecycle_generation=publication.lifecycle_generation
     AND selection.revision_id=publication.revision_id AND selection.publication_id=publication.publication_id
    JOIN content.knowledge_revision revision
      ON revision.route=publication.route AND revision.document_id=publication.document_id
     AND revision.revision_id=publication.revision_id AND revision.body_sha256=publication.body_sha256
    WHERE publication.route=document.route AND publication.document_id=document.document_id
      AND publication.publication_id=document.current_publication_id
      AND publication.lifecycle_generation=document.lifecycle_generation
  )
RETURNING document.document_id;
