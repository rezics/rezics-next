SELECT p.placement_id, p.document_id, p.parent_id, p.position, r.title
FROM content.knowledge_placement p
JOIN content.knowledge_document d
  ON d.route=p.route AND d.notebook_id=p.notebook_id AND d.document_id=p.document_id
JOIN content.knowledge_revision r
  ON r.route=d.route AND r.document_id=d.document_id AND r.revision_id=d.head_revision_id
WHERE p.route=:route AND p.notebook_id=:notebook_id AND p.parent_id IS NULL
  AND (p.position, p.placement_id) > (:after_position, :after_placement_id)
ORDER BY p.position, p.placement_id
LIMIT :limit;
