-- migrate:up
ALTER TABLE rating.source_statistic ADD COLUMN source_alias text;
UPDATE rating.source_statistic SET source_alias = source;
ALTER TABLE rating.source_statistic
  ALTER COLUMN source_alias SET NOT NULL,
  ALTER COLUMN source_alias SET DEFAULT 'vndb',
  ADD CONSTRAINT source_statistic_source_alias_check
    CHECK (octet_length(source_alias) BETWEEN 1 AND 32
           AND source_alias ~ '^[a-z][a-z0-9_-]{0,31}$'
           AND source_alias !~ '[^a-z0-9_-]');

-- migrate:down
-- Forward only: exact imported tuple identity must survive rollback.
