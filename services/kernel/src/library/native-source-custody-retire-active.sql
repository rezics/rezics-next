-- Partial index makes a live hold a point-sized stop, even behind released history.
SELECT hold_id::text AS id FROM library.native_source_hold
WHERE route=:route AND capture_id=:capture_id AND NOT released
ORDER BY hold_id LIMIT 1 FOR UPDATE;
