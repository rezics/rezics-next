SELECT notebook_id
FROM content.knowledge_document
WHERE route=:route::integer AND document_id=:document_id::uuid;
