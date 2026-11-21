-- migrate:up
ALTER TABLE search.public_preparation DROP CONSTRAINT public_preparation_kind_check,
  ADD CONSTRAINT public_preparation_kind_check CHECK (kind IN ('population', 'repair') OR (kind = 'close' AND starts_with(prefix, 'close:')));

-- migrate:down
-- Drain retained closes with a close-aware worker before removing schema support.
-- Constraint validation refuses rollback atomically while any receipt remains.
ALTER TABLE search.public_preparation DROP CONSTRAINT public_preparation_kind_check,
  ADD CONSTRAINT public_preparation_kind_check CHECK (kind IN ('population', 'repair'));
