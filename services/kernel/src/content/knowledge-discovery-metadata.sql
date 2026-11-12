-- Exact current publication metadata only. Never fetch canonical_bytes for a list row.
SELECT d.route, d.document_id, p.publication_id, p.revision_id, p.subject_id,
       r.title, r.language, r.licence, r.subject_ids,
       encode(p.body_sha256, 'hex') AS sha256,
       to_char(p.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS published_at
FROM content.knowledge_document d
JOIN content.knowledge_publication p
  ON p.route=d.route AND p.document_id=d.document_id AND p.publication_id=d.current_publication_id
JOIN content.knowledge_revision r
  ON r.route=p.route AND r.document_id=p.document_id AND r.revision_id=p.revision_id
WHERE d.route=:route AND d.document_id=:document_id
  AND p.lifecycle_generation=d.lifecycle_generation
  AND content.knowledge_document_eligible(d.route,d.document_id);
