-- Retained plan evidence owns this capture until a real native control handoff releases it.
SELECT plan_key FROM library.identity_scope_plan
WHERE route=:route AND capture_id=:capture_id
ORDER BY collection_id,plan_key LIMIT 1 FOR SHARE;
