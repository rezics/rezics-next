-- migrate:up

CREATE INDEX copy_account_kind_created
  ON library.copy (route, account_id, kind, created_at, copy_id)
  WHERE deletion_id IS NULL AND kind IS NOT NULL;

CREATE INDEX copy_account_status_created
  ON library.copy (route, account_id, status, created_at, copy_id)
  WHERE deletion_id IS NULL;

CREATE INDEX copy_account_kind_status_created
  ON library.copy (route, account_id, kind, status, created_at, copy_id)
  WHERE deletion_id IS NULL AND kind IS NOT NULL;

CREATE INDEX copy_account_subject_kind_created
  ON library.copy (route, account_id, subject_id, kind, created_at, copy_id)
  WHERE deletion_id IS NULL AND kind IS NOT NULL;

CREATE INDEX copy_account_subject_status_created
  ON library.copy (route, account_id, subject_id, status, created_at, copy_id)
  WHERE deletion_id IS NULL;

CREATE INDEX copy_account_subject_kind_status_created
  ON library.copy (route, account_id, subject_id, kind, status, created_at, copy_id)
  WHERE deletion_id IS NULL AND kind IS NOT NULL;
