WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id, :revision_id::uuid AS revision_id,
         :publication_id::uuid AS publication_id, :generation::text::bigint AS generation
)
SELECT NULL::uuid AS owner_account_id,publication.subject_id,revision.subject_ids,revision.media_ids,
       publication.body_sha256,publication.publication_id,document.lifecycle_generation::text
FROM input i
JOIN content.knowledge_document document ON document.route=i.route AND document.document_id=i.document_id
JOIN content.knowledge_publication live
  ON live.route=document.route AND live.document_id=document.document_id
 AND live.publication_id=document.current_publication_id AND live.lifecycle_generation=document.lifecycle_generation
JOIN content.knowledge_publication_selection selection
  ON selection.route=document.route AND selection.document_id=document.document_id
 AND selection.lifecycle_generation=document.lifecycle_generation AND selection.revision_id=i.revision_id
 AND selection.publication_id=i.publication_id
JOIN content.knowledge_publication publication
  ON publication.route=selection.route AND publication.document_id=selection.document_id
 AND publication.publication_id=selection.publication_id AND publication.revision_id=selection.revision_id
 AND publication.lifecycle_generation=selection.lifecycle_generation
JOIN content.knowledge_revision revision
  ON revision.route=publication.route AND revision.document_id=publication.document_id
 AND revision.revision_id=publication.revision_id AND revision.body_sha256=publication.body_sha256
WHERE document.lifecycle_generation=i.generation
  AND content.knowledge_document_eligible(document.route,document.document_id);
