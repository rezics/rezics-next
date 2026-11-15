WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id
)
SELECT CASE
  WHEN content.knowledge_document_eligible(document.route,document.document_id) AND EXISTS (
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
  ) THEN 'retained'
  WHEN document.legal_hold THEN 'pending'
  WHEN document.purge_started_at IS NOT NULL OR document.purge_completed THEN 'erased'
  ELSE 'pending'
END AS disposition,document.lifecycle_generation::text
FROM input i
JOIN content.knowledge_document document ON document.route=i.route AND document.document_id=i.document_id;
