WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id,
         :revision_id::uuid AS revision_id, :publication_id::uuid AS publication_id,
         :uploader_id::uuid AS uploader_id
), context AS MATERIALIZED (
  SELECT document.route, document.document_id, document.lifecycle_generation, revision.media_ids
  FROM input
  JOIN content.knowledge_document AS document
    ON document.route = input.route AND document.document_id = input.document_id
  JOIN content.knowledge_notebook AS notebook
    ON notebook.route = document.route AND notebook.notebook_id = document.notebook_id
   AND notebook.owner_account_id = input.uploader_id
  JOIN content.knowledge_publication AS publication
    ON publication.route = document.route AND publication.document_id = document.document_id
   AND publication.publication_id = input.publication_id AND publication.revision_id = input.revision_id
   AND publication.lifecycle_generation = document.lifecycle_generation
  JOIN content.knowledge_publication_selection AS selection
    ON selection.route = publication.route AND selection.document_id = publication.document_id
   AND selection.lifecycle_generation = publication.lifecycle_generation
   AND selection.revision_id = publication.revision_id AND selection.publication_id = publication.publication_id
  JOIN content.knowledge_revision AS revision
    ON revision.route = publication.route AND revision.document_id = publication.document_id
   AND revision.revision_id = publication.revision_id
  WHERE document.current_publication_id = input.publication_id
    AND cardinality(revision.media_ids) <= 32
    AND content.knowledge_document_eligible(document.route, document.document_id)
  FOR UPDATE OF notebook
), locked AS MATERIALIZED (
  SELECT media.route, media.media_id, media.container_id, media.uploader_id, media.purpose,
         media.state, media.erased, media.collection_pending, media.taken_down, media.claimed_at,
         media.claimed_item_id, media.claimed_realm_id, media.knowledge_publication_generation
  FROM content.media AS media CROSS JOIN context
  WHERE media.route = context.route AND media.media_id = ANY(context.media_ids)
  ORDER BY media.media_id
  FOR UPDATE OF media
), valid AS MATERIALIZED (
  SELECT media.route, media.media_id, media.knowledge_publication_generation
  FROM locked AS media CROSS JOIN input
  WHERE media.container_id = input.document_id AND media.uploader_id = input.uploader_id
    AND media.purpose = 'knowledge-image' AND media.state = 'available'
    AND NOT media.erased AND NOT media.collection_pending AND NOT media.taken_down
    AND media.claimed_at IS NOT NULL
    AND media.claimed_item_id IS NULL AND media.claimed_realm_id IS NULL
), changed AS (
  UPDATE content.media AS media
  SET knowledge_publication_generation = context.lifecycle_generation
  FROM valid CROSS JOIN context
  WHERE media.route = valid.route AND media.media_id = valid.media_id
    AND valid.knowledge_publication_generation IS DISTINCT FROM context.lifecycle_generation
    AND (SELECT count(*) FROM valid) = cardinality(context.media_ids)
  RETURNING media.media_id
)
SELECT EXISTS (SELECT 1 FROM context) AS eligible,
       (SELECT cardinality(media_ids) FROM context) AS "mediaCount",
       (SELECT count(*)::integer FROM valid) AS "retainedCount";
