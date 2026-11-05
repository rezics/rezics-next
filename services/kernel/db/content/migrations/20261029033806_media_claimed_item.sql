-- migrate:up
ALTER TABLE content.media
  ADD COLUMN claimed_item_id uuid,
  ADD CONSTRAINT media_claimed_item_check CHECK (
    claimed_item_id IS NULL OR (purpose = 'post-image' AND claimed_at IS NOT NULL)
  ),
  ADD CONSTRAINT media_claimed_item_route_check CHECK (
    route = get_byte(uuid_send(claimed_item_id), 10) * 256 + get_byte(uuid_send(claimed_item_id), 11)
  );

-- Backfill start
WITH first_reference AS MATERIALIZED (
  SELECT DISTINCT ON (r.route, ref.media_id) r.route, ref.media_id, r.post_id
  FROM content.revision r
  CROSS JOIN LATERAL unnest(r.media_ids) AS ref(media_id)
  ORDER BY r.route, ref.media_id, r.recorded_at, r.revision_id
)
UPDATE content.media m
SET claimed_item_id = first_reference.post_id
FROM first_reference
WHERE m.route = first_reference.route AND m.media_id = first_reference.media_id
  AND m.purpose = 'post-image' AND m.claimed_at IS NOT NULL AND m.claimed_item_id IS NULL;
-- Backfill end

-- migrate:down
DO $$ BEGIN
  RAISE EXCEPTION 'Post image ownership migration is forward only';
END $$;
