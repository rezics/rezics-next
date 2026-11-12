SELECT d.route, d.document_id, d.current_publication_id,
       p.publication_id, p.revision_id, p.subject_id, p.body_sha256 AS publication_sha256,
       r.subject_ids
FROM content.knowledge_document d
JOIN content.knowledge_publication p
  ON p.route=d.route AND p.document_id=d.document_id AND p.publication_id=d.current_publication_id
JOIN content.knowledge_revision r
  ON r.route=p.route AND r.document_id=p.document_id AND r.revision_id=p.revision_id
WHERE d.route=:route AND d.document_id=:document_id;
