-- migrate:up
ALTER TABLE search.scope_preparation ADD COLUMN ordered_state jsonb;
ALTER TABLE search.scope_preparation ADD CONSTRAINT scope_preparation_ordered_state_check
  CHECK (octet_length(ordered_state::text) <= 32768);
CREATE TABLE search.scope_preparation_ordered (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL,
  subject uuid NOT NULL,
  count_key integer NOT NULL CHECK (count_key BETWEEN -2147483647 AND 0),
  name_key bytea NOT NULL CHECK (octet_length(name_key) BETWEEN 1 AND 1537),
  hit bytea NOT NULL CHECK (octet_length(hit) <= 16384),
  PRIMARY KEY (partition_no,prefix,scope_id,subject)
);
CREATE INDEX scope_preparation_ordered_page ON search.scope_preparation_ordered
  (partition_no,prefix,scope_id,count_key,name_key,subject);
-- migrate:down
DROP TABLE search.scope_preparation_ordered;
ALTER TABLE search.scope_preparation DROP COLUMN ordered_state;
