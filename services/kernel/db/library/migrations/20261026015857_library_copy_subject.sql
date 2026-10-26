-- migrate:up
CREATE INDEX copy_account_subject_created ON library.copy (route, account_id, subject_id, created_at, copy_id);

-- migrate:down
-- Forward only: do not remove the copy-list index in a rollback.
