-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY public_filter_bootstrap_publication_observation
  ON semantic.public_filter_bootstrap(partition_no, publication_observation COLLATE "C")
  WHERE publication_observation IS NOT NULL;

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY semantic.public_filter_bootstrap_publication_observation;
