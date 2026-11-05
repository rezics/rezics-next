-- migrate:up
CREATE INDEX principal_assignment_speakers
ON access.principal_assignment (route, principal_id, assigned_actor_id, (COALESCE(lower(valid), '-infinity'::timestamptz)))
INCLUDE (valid)
WHERE revoked_at IS NULL;

-- migrate:down
DROP INDEX access.principal_assignment_speakers;
