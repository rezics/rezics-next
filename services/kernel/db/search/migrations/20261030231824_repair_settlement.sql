-- migrate:up
-- Children of the existing retained execution, not a second consumer registry.
ALTER TABLE search.public_filter_execution ADD COLUMN repair_settlement text
  CHECK (octet_length(repair_settlement)<=16384);
CREATE TABLE search.public_filter_repair_page (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal>=0),
  has_repairs boolean NOT NULL,
  intent text NOT NULL CHECK (octet_length(intent)<=1048576),
  PRIMARY KEY (partition_no,observation,execution,ordinal),
  FOREIGN KEY (partition_no,observation,execution)
    REFERENCES search.public_filter_execution(partition_no,observation,id)
);
CREATE TABLE search.public_filter_repair_effect (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  page integer NOT NULL,
  item integer NOT NULL CHECK (item>=0),
  receipt text NOT NULL CHECK (octet_length(receipt)<=1048576),
  PRIMARY KEY (partition_no,observation,execution,page,item),
  FOREIGN KEY (partition_no,observation,execution,page)
    REFERENCES search.public_filter_repair_page(partition_no,observation,execution,ordinal)
);
CREATE INDEX public_filter_repair_page_effects ON search.public_filter_repair_page
  (partition_no,observation,execution,ordinal) WHERE has_repairs;
-- The actual writer retains its exact pre-dispatch body and recovery locator in its own home.
ALTER TABLE search.identity_writer ADD COLUMN repair_locator text CHECK (octet_length(repair_locator)<=8192),
  ADD COLUMN repair_action text CHECK (octet_length(repair_action)<=1048576),
  ADD COLUMN repair_receipt text CHECK (octet_length(repair_receipt)<=1048576);

-- migrate:down
ALTER TABLE search.identity_writer DROP COLUMN repair_receipt, DROP COLUMN repair_action, DROP COLUMN repair_locator;
DROP TABLE search.public_filter_repair_effect;
DROP TABLE search.public_filter_repair_page;
ALTER TABLE search.public_filter_execution DROP COLUMN repair_settlement;
