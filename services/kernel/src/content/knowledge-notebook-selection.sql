SELECT owner_account_id, structure_revision_id
FROM content.knowledge_notebook
WHERE route=:route AND notebook_id=:notebook_id;
