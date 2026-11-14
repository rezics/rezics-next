WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :document_id::uuid AS document_id,
         :revision_id::uuid AS revision_id, :uploader_id::uuid AS uploader_id,
         :media_ids::uuid[] AS media_ids, :at::timestamptz AS at
), context AS MATERIALIZED (
  SELECT document.route, document.document_id, revision.media_ids
  FROM input
  JOIN content.knowledge_document AS document
    ON document.route = input.route AND document.document_id = input.document_id
  JOIN content.knowledge_notebook AS notebook
    ON notebook.route = document.route AND notebook.notebook_id = document.notebook_id
   AND notebook.owner_account_id = input.uploader_id
  JOIN content.knowledge_revision AS revision
    ON revision.route = document.route AND revision.document_id = document.document_id
   AND revision.revision_id = input.revision_id AND revision.author_account_id = input.uploader_id
  WHERE document.head_revision_id = input.revision_id
    AND cardinality(input.media_ids) <= 32 AND cardinality(revision.media_ids) <= 32
    AND revision.media_ids @> input.media_ids AND input.media_ids @> revision.media_ids
    AND content.knowledge_document_eligible(document.route, document.document_id)
  FOR UPDATE OF notebook
), locked AS MATERIALIZED (
  SELECT media.route, media.media_id, media.container_id, media.uploader_id, media.purpose,
         media.state, media.erased, media.collection_pending, media.taken_down, media.claimed_at,
         media.claimed_item_id, media.claimed_realm_id
  FROM content.media AS media CROSS JOIN input
  WHERE media.route = input.route AND media.media_id = ANY(input.media_ids)
    AND EXISTS (SELECT 1 FROM context)
  ORDER BY media.media_id
  FOR UPDATE OF media
), valid AS MATERIALIZED (
  SELECT media.route, media.media_id, media.claimed_at
  FROM locked AS media CROSS JOIN input
  WHERE media.container_id = input.document_id AND media.uploader_id = input.uploader_id
    AND media.purpose = 'knowledge-image' AND media.state = 'available'
    AND NOT media.erased AND NOT media.collection_pending AND NOT media.taken_down
    AND media.claimed_item_id IS NULL AND media.claimed_realm_id IS NULL
    AND EXISTS (SELECT 1 FROM context WHERE media.media_id = ANY(context.media_ids))
), changed AS (
  UPDATE content.media AS media
  SET claimed_at = input.at
  FROM valid CROSS JOIN input
  WHERE media.route = valid.route AND media.media_id = valid.media_id
    AND valid.claimed_at IS NULL
    AND (SELECT count(*) FROM valid) = cardinality(input.media_ids)
  RETURNING media.media_id
)
SELECT EXISTS (SELECT 1 FROM context) AS eligible,
       (SELECT count(*)::integer FROM valid) AS "claimedCount";
