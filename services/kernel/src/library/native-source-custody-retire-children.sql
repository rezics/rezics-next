DELETE FROM library.native_source_hold
WHERE route=:route AND capture_id=:capture_id AND hold_id=ANY(:hold_ids::uuid[])
AND released AND xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
RETURNING hold_id;
