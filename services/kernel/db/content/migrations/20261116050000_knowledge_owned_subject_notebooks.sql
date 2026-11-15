-- migrate:up
CREATE INDEX knowledge_notebook_owner_subject_page
ON content.knowledge_notebook (route, owner_account_id, subject_id, created_at DESC, notebook_id)
WHERE NOT account_erased;

-- migrate:down
DROP INDEX content.knowledge_notebook_owner_subject_page;
