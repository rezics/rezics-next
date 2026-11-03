-- migrate:up
-- Current figures duplicate the immutable head payload for bounded two-slot reads.
-- NULL means no figures were supplied, including all observations predating this encoding.
ALTER TABLE rating.source_statistic ADD COLUMN figures jsonb;
ALTER TABLE rating.source_statistic ADD CONSTRAINT source_statistic_figures_check CHECK (
  figures IS NULL OR (source = 'bangumi' AND jsonb_typeof(figures) = 'object'
    AND figures->>'schemaVersion' = '1' AND octet_length(figures::text) <= 4096)
);
ALTER TABLE rating.source_statistic_observation ADD CONSTRAINT source_observation_bytes_check
  CHECK (octet_length(payload::text) <= 32768);

-- migrate:down
-- Forward only: retained observations and their encoding must remain readable.
