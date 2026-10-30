-- migrate:up
CREATE TABLE search.scope_preparation (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL CHECK (scope_id ~ '^[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (octet_length(definition::text)<=262144),
  frontier jsonb NOT NULL CHECK (octet_length(frontier::text)<=8192),
  observation jsonb CHECK (octet_length(observation::text)<=8192),
  ordinal_membership_progress jsonb CHECK (octet_length(ordinal_membership_progress::text)<=8192),
  leaf_progress jsonb CHECK (octet_length(leaf_progress::text)<=4096),
  ordinal_frontier jsonb CHECK (octet_length(ordinal_frontier::text)<=1024),
  ordinal_complete boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'capture' CHECK (state IN ('capture','ready','retained')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  lease_until bigint NOT NULL DEFAULT 0,
  due_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (partition_no,prefix,scope_id)
);
CREATE INDEX scope_preparation_due ON search.scope_preparation(prefix,due_at,scope_id) WHERE state='capture';

CREATE TABLE search.scope_preparation_ordinal (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL,
  cut text COLLATE "C" NOT NULL CHECK (cut ~ '^[0-9a-f]{64}$'),
  subject uuid NOT NULL,
  ordinal_key text COLLATE "C" NOT NULL CHECK (octet_length(ordinal_key)<=256),
  member_id uuid NOT NULL,
  PRIMARY KEY (partition_no,prefix,scope_id,cut,subject)
);
CREATE INDEX scope_preparation_ordinal_page ON search.scope_preparation_ordinal
  (partition_no,prefix,scope_id,cut,ordinal_key,member_id);

-- migrate:down
DROP TABLE search.scope_preparation_ordinal;
DROP TABLE search.scope_preparation;
