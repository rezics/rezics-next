UPDATE library.published_log
SET account_id=NULL, session_id=NULL, subject_id=NULL, session_state=NULL, started_at=NULL, completed_at=NULL,
    note=NULL, published_at=NULL, transaction_id=NULL, deletion_id=NULL, deleted_at=NULL, restore_until=NULL
WHERE route=:route::integer AND log_id=:log_id::uuid AND deleted
  AND deletion_id=:deletion_id::uuid AND revision=:revision::integer
  AND restore_until=:restore_until::timestamptz AND restore_until <= :time::timestamptz
RETURNING true AS purged;
