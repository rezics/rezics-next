-- migrate:up
-- Review population must retain its opaque owner continuation alongside the exact native full-key frontier.
ALTER TABLE search.discovery_population
  ADD COLUMN IF NOT EXISTS continuation jsonb;

ALTER TABLE search.discovery_population
  DROP CONSTRAINT IF EXISTS discovery_population_owner_check,
  ADD CONSTRAINT discovery_population_owner_check
    CHECK (owner IN ('accounts','semantic','collection','review','space'));

-- migrate:down
-- Forward only: populated metadata frontiers and review continuation receipts are durable recovery state.
