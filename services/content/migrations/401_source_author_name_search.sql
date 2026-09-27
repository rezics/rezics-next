CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX author_name_text_idx ON source.author_name_revision
  USING gin (lower(display_name) gin_trgm_ops) WHERE display_name IS NOT NULL;
