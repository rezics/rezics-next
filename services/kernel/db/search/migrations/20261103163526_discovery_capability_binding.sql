-- migrate:up
-- A native capability belongs to the exact physical population, never just its numeric frontier.
ALTER TABLE search.discovery_generation ADD COLUMN capability jsonb;
ALTER TABLE search.discovery_population
  ADD COLUMN native_complete boolean NOT NULL DEFAULT false,
  ADD COLUMN native_epoch integer;

-- Existing certified rows have no native replay witness. Recovery must recertify them.
UPDATE search.discovery_population SET certified=false WHERE owner IN ('collection','review','space');

-- migrate:down
-- Forward only: capability bindings and raw replay frontiers are durable recovery state.
