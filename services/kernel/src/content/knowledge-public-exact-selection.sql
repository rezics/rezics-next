SELECT d.route, d.document_id, d.current_publication_id, d.lifecycle_generation::text AS lifecycle_generation,
       p.publication_id, p.revision_id, p.subject_id, p.body_sha256 AS publication_sha256,
       r.subject_ids, r.block_ids
FROM content.knowledge_document d
JOIN content.knowledge_publication live
  ON live.route=d.route AND live.document_id=d.document_id
 AND live.publication_id=d.current_publication_id AND live.lifecycle_generation=d.lifecycle_generation
JOIN content.knowledge_publication_selection s
  ON s.route=d.route AND s.document_id=d.document_id AND s.lifecycle_generation=d.lifecycle_generation
 AND s.revision_id=:revision_id
JOIN content.knowledge_publication p
  ON p.route=s.route AND p.document_id=s.document_id
 AND p.lifecycle_generation=s.lifecycle_generation AND p.revision_id=s.revision_id
 AND p.publication_id=s.publication_id
JOIN content.knowledge_revision r
  ON r.route=p.route AND r.document_id=p.document_id AND r.revision_id=p.revision_id
WHERE d.route=:route AND d.document_id=:document_id
  AND content.knowledge_document_eligible(d.route,d.document_id);
