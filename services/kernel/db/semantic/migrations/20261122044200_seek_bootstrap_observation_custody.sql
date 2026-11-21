-- migrate:up transaction:false
CREATE INDEX CONCURRENTLY public_filter_bootstrap_queried_observation
  ON semantic.public_filter_bootstrap(partition_no, queried COLLATE "C") WHERE queried IS NOT NULL;

-- migrate:down transaction:false
DROP INDEX CONCURRENTLY semantic.public_filter_bootstrap_queried_observation;
