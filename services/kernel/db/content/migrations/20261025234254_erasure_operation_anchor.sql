-- migrate:up
-- Keep the exact post whose post:erase authority started the operation.
-- Backfill is the sole exception to the immutable operation identity trigger.
DROP TRIGGER operation_identity ON content.operation;

ALTER TABLE content.operation ADD COLUMN anchor_post_id uuid;

UPDATE content.operation AS operation
SET anchor_post_id = COALESCE(
  operation.creation_target_id,
  (
    SELECT post.post_id
    FROM content.post AS post
    WHERE post.route = operation.route
      AND post.thread_id = operation.thread_id
      AND post.author_account_id = operation.author_account_id
      AND post.created_at <= operation.requested_at
    ORDER BY post.created_at, post.post_id
    LIMIT 1
  )
);

ALTER TABLE content.operation
  ALTER COLUMN anchor_post_id SET NOT NULL,
  ADD CONSTRAINT operation_anchor_post_id_check
    CHECK (content.operation_routable_uuid(anchor_post_id)),
  ADD CONSTRAINT operation_anchor_post_route
    CHECK (route = get_byte(uuid_send(anchor_post_id), 10) * 256
      + get_byte(uuid_send(anchor_post_id), 11));

CREATE TRIGGER operation_identity BEFORE INSERT OR UPDATE OR DELETE ON content.operation
FOR EACH ROW EXECUTE FUNCTION content.guard_operation_identity();

-- migrate:down
-- Forward only: operation visibility depends on this immutable anchor.
