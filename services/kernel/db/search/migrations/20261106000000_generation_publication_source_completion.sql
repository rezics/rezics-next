-- migrate:up
ALTER TABLE search.generation_publication
  ADD COLUMN source_completion_started boolean NOT NULL DEFAULT false;

-- migrate:down
-- Forward only: source completion invocation intent must survive rollback.
