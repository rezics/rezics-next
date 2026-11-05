-- migrate:up
-- Maintained presentation only; native Source and disclosure remain authoritative.
CREATE TABLE library.collection_kind_observation (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  audience text NOT NULL CHECK (octet_length(audience) BETWEEN 1 AND 256),
  generation uuid NOT NULL,
  source_generation bigint NOT NULL,
  capture text NOT NULL CHECK (octet_length(capture) BETWEEN 1 AND 4096),
  after_subject uuid,
  frontier text CHECK (octet_length(frontier) BETWEEN 1 AND 4096),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  complete boolean NOT NULL DEFAULT false,
  winner text,
  PRIMARY KEY (route, collection_id, audience),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = (get_byte(uuid_send(collection_id),10)*256+get_byte(uuid_send(collection_id),11))),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))),
  CHECK (complete OR winner IS NULL)
);
CREATE INDEX collection_kind_observation_account ON library.collection_kind_observation
  (route, account_id, collection_id, audience);
CREATE TABLE library.collection_kind_subject (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  audience text NOT NULL,
  generation uuid NOT NULL,
  subject_id uuid NOT NULL,
  type_id text NOT NULL,
  PRIMARY KEY (route, collection_id, audience, generation, subject_id)
);
CREATE INDEX collection_kind_subject_account ON library.collection_kind_subject
  (route, account_id, collection_id, audience, generation, subject_id);
CREATE TABLE library.collection_kind_count (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  audience text NOT NULL,
  generation uuid NOT NULL,
  type_id text COLLATE "C" NOT NULL,
  votes bigint NOT NULL CHECK (votes > 0),
  PRIMARY KEY (route, collection_id, audience, generation, type_id)
);
CREATE INDEX collection_kind_winner ON library.collection_kind_count
  (route, collection_id, audience, generation, votes DESC, type_id);
CREATE INDEX collection_kind_count_account ON library.collection_kind_count
  (route, account_id, collection_id, audience, generation, type_id);
-- Obsolete generations have an exact retirement locator; cleanup never scans the live population.
CREATE TABLE library.collection_kind_retired (
  route integer NOT NULL,
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  audience text NOT NULL,
  generation uuid NOT NULL,
  capture text NOT NULL,
  PRIMARY KEY (route, collection_id, audience, generation)
);
CREATE INDEX collection_kind_retired_account ON library.collection_kind_retired
  (route, account_id, collection_id, audience, generation);

-- migrate:down
DROP TABLE library.collection_kind_retired;
DROP TABLE library.collection_kind_count;
DROP TABLE library.collection_kind_subject;
DROP TABLE library.collection_kind_observation;
