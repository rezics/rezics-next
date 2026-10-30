-- A point read only: a fresh hold in this command is not committed retained provenance.
SELECT transaction_id::text AS "transactionId" FROM library.native_source_hold
WHERE route=:route AND capture_id=:capture_id AND hold_id=:hold_id AND NOT released
AND xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
FOR SHARE;
