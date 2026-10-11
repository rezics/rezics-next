-- A per-author refresh is serialized by its advisory lock. Allocate its native
-- publication position after that lock, so retries cannot replace a newer name.
ALTER TABLE source.author_name_revision ADD COLUMN native_position bigint
  GENERATED ALWAYS AS IDENTITY;
