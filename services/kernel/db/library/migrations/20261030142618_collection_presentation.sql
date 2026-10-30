-- migrate:up
-- References remain on their original Content home; this is neither a claim nor an ACL.
ALTER TABLE library.collection
  ADD COLUMN presentation_kind text,
  ADD COLUMN cover_media_id uuid;

-- migrate:down
-- Forward only: retained owner presentation choices must survive rollback.
