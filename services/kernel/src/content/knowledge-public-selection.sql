SELECT d.route, d.document_id, d.current_publication_id, d.lifecycle_generation::text AS lifecycle_generation,
       p.publication_id, p.revision_id, p.subject_id, p.body_sha256 AS publication_sha256,
       r.subject_ids, r.block_ids
FROM content.knowledge_document d
JOIN content.knowledge_publication p
  ON p.route=d.route AND p.document_id=d.document_id
 AND p.publication_id=d.current_publication_id AND p.lifecycle_generation=d.lifecycle_generation
JOIN content.knowledge_publication_selection s
  ON s.route=p.route AND s.document_id=p.document_id
 AND s.lifecycle_generation=p.lifecycle_generation AND s.revision_id=p.revision_id
JOIN content.knowledge_revision r
  ON r.route=p.route AND r.document_id=p.document_id AND r.revision_id=p.revision_id
WHERE d.route=:route AND d.document_id=:document_id
  AND content.knowledge_document_eligible(d.route,d.document_id);
