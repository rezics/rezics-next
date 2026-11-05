-- Retained receipts cannot be updated; only child-free owner retirement can delete one.
DELETE FROM library.native_source_receipt r WHERE route=:route AND capture_id=:capture_id
AND NOT EXISTS (SELECT 1 FROM library.native_source_hold h WHERE h.route=r.route AND h.capture_id=r.capture_id)
RETURNING capture_id;
