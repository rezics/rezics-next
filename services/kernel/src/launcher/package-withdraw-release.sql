-- unbound: one Global exact package decrement in the release withdrawal command.
UPDATE launcher.package
SET live_count = live_count - 1
WHERE id = :id::text AND live_count > 0
RETURNING id;
