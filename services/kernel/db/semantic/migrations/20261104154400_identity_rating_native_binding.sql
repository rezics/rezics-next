-- migrate:up
-- Domain replay evidence, independent of the producer's vote/provenance inventory.
CREATE TABLE semantic.identity_rating_repair_journal (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  scope_key text NOT NULL CHECK (scope_key ~ '^[a-f0-9]{64}$'),
  scope jsonb NOT NULL CHECK (octet_length(scope::text) <= 4096),
  owner_node text NOT NULL,
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  checkpoint jsonb CHECK (octet_length(checkpoint::text) <= 32768),
  reclaimed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no, scope_key),
  CHECK (NOT reclaimed OR checkpoint->>'phase' = 'complete')
);

CREATE TABLE semantic.identity_rating_repair_page (
  partition_no integer NOT NULL,
  scope_key text NOT NULL,
  selection_digest text NOT NULL CHECK (selection_digest ~ '^[a-f0-9]{64}$'),
  selected_page jsonb NOT NULL CHECK (octet_length(selected_page::text) <= 131072),
  binding jsonb NOT NULL CHECK (octet_length(binding::text) <= 16384),
  receipt jsonb NOT NULL CHECK (octet_length(receipt::text) <= 8192),
  acknowledged boolean NOT NULL DEFAULT false,
  PRIMARY KEY (partition_no, scope_key, selection_digest),
  FOREIGN KEY (partition_no, scope_key)
    REFERENCES semantic.identity_rating_repair_journal(partition_no, scope_key)
);
CREATE UNIQUE INDEX identity_rating_repair_page_unacknowledged
  ON semantic.identity_rating_repair_page(partition_no, scope_key) WHERE NOT acknowledged;

-- migrate:down
DROP TABLE semantic.identity_rating_repair_page;
DROP TABLE semantic.identity_rating_repair_journal;
