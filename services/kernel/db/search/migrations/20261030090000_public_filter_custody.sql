-- migrate:up
-- Home-leading custody, deliberately separate from Source's authoritative catalogue configuration.
CREATE TABLE search.public_filter_target (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL,
  incarnation text NOT NULL,
  PRIMARY KEY (partition_no, physical_target)
);
CREATE TABLE search.public_filter_registration (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  id text COLLATE "C" NOT NULL,
  physical_target text COLLATE "C" NOT NULL,
  consumer text NOT NULL CHECK (octet_length(consumer) <= 8192),
  definition text NOT NULL CHECK (octet_length(definition) <= 1048576),
  state text NOT NULL CHECK (state IN ('active', 'retired')),
  PRIMARY KEY (partition_no, id),
  FOREIGN KEY (partition_no, physical_target) REFERENCES search.public_filter_target
);
CREATE TABLE search.public_filter_observation (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  observation text COLLATE "C" NOT NULL,
  registration text COLLATE "C" NOT NULL,
  queried text NOT NULL CHECK (octet_length(queried) <= 65536),
  covered text NOT NULL CHECK (octet_length(covered) <= 4096),
  expires_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closing', 'closed')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  prepared_rows text CHECK (octet_length(prepared_rows) <= 1048576),
  PRIMARY KEY (partition_no, observation),
  FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration
);
CREATE TABLE search.public_filter_execution (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  id text COLLATE "C" NOT NULL,
  execution text NOT NULL CHECK (octet_length(execution) <= 1048576),
  PRIMARY KEY (partition_no, observation, id),
  FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation
);
CREATE TABLE search.public_filter_reference (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  token uuid NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (partition_no, observation, token),
  FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation
);
-- migrate:down
-- Forward only: retained immutable definitions/executions and retired identities are not reclaimed here.
