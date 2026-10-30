DELETE FROM library.native_source_capture c WHERE route=:route AND capture_id=:capture_id
AND NOT EXISTS (SELECT 1 FROM library.native_source_receipt r WHERE r.route=c.route AND r.capture_id=c.capture_id)
RETURNING capture_id;
