SELECT n.route, n.notebook_id, n.owner_account_id, n.subject_id, n.structure_revision_id,
       d.document_id, d.head_revision_id, d.current_publication_id,
       p.placement_id, p.parent_id,
       r.title, r.language, r.canonical_bytes, r.body_sha256, r.licence, r.subject_ids, r.author_account_id
FROM content.knowledge_notebook n
JOIN content.knowledge_document d ON d.route=n.route AND d.notebook_id=n.notebook_id
JOIN content.knowledge_placement p ON p.route=n.route AND p.notebook_id=n.notebook_id AND p.document_id=d.document_id
JOIN content.knowledge_revision r ON r.route=d.route AND r.document_id=d.document_id AND r.revision_id=d.head_revision_id
WHERE n.route=:route AND n.notebook_id=:notebook_id AND d.document_id=:document_id;
