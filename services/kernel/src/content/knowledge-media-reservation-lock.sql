SELECT notebook.notebook_id
FROM content.knowledge_document document
JOIN content.knowledge_notebook notebook ON notebook.route=document.route AND notebook.notebook_id=document.notebook_id
WHERE document.route=:route::integer AND document.document_id=:document_id::uuid
  AND NOT document.account_erased AND NOT notebook.account_erased
FOR UPDATE OF notebook;
