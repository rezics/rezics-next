-- migrate:up
-- Pin the original Source job, bootstrap, queried observation and execution on the publication row.
-- Resume and activation reuse that exact tuple. Tagged proof encoding lives in the application layer.
ALTER TABLE search.generation_publication
  ADD COLUMN bootstrap text CHECK (octet_length(bootstrap) BETWEEN 1 AND 4096),
  ADD COLUMN queried text CHECK (octet_length(queried) BETWEEN 1 AND 262144),
  ADD COLUMN execution text CHECK (octet_length(execution) BETWEEN 1 AND 4096),
  ADD CONSTRAINT generation_publication_pin_shape CHECK (
    (bootstrap IS NULL) = (queried IS NULL) AND (queried IS NULL) = (execution IS NULL)
  );
CREATE UNIQUE INDEX generation_publication_bootstrap
  ON search.generation_publication (partition_no, bootstrap)
  WHERE bootstrap IS NOT NULL;

-- migrate:down
DROP INDEX search.generation_publication_bootstrap;
ALTER TABLE search.generation_publication
  DROP CONSTRAINT generation_publication_pin_shape,
  DROP COLUMN execution,
  DROP COLUMN queried,
  DROP COLUMN bootstrap;
