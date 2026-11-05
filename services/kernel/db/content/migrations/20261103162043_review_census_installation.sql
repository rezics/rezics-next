-- migrate:up
-- These are private native projection rows, not an eligibility certificate or a
-- public count. The old episode survives replacement and physical source removal.
CREATE TABLE content.review_census_installation (
  route integer PRIMARY KEY CHECK (route BETWEEN 0 AND 65535 AND route % 16=0),
  generation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  after_route integer,
  after_id uuid,
  after_token text CHECK (octet_length(after_token)<=65536),
  cut jsonb,
  exhausted boolean NOT NULL DEFAULT false,
  observed_public bigint NOT NULL DEFAULT 0 CHECK (observed_public>=0),
  examined bigint NOT NULL DEFAULT 0 CHECK (examined>=0),
  CHECK ((after_route IS NULL)=(after_id IS NULL) AND (after_id IS NULL)=(after_token IS NULL)),
  CHECK (after_route IS NULL OR after_route/16=route/16),
  CHECK (cut IS NULL OR (jsonb_typeof(cut)='object' AND jsonb_typeof(cut->'homes')='array'
    AND jsonb_array_length(cut->'homes') BETWEEN 1 AND 256)),
  CHECK (NOT exhausted OR (cut IS NOT NULL AND after_id IS NULL))
);
CREATE TABLE content.review_census_episode (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  source_version text NOT NULL CHECK (source_version ~ '^rv1_[A-Za-z0-9_-]{43}$'),
  board_id uuid,
  realm_id uuid,
  subject_id uuid,
  opening_id uuid,
  revision_id uuid,
  eligible boolean NOT NULL,
  PRIMARY KEY(route,thread_id,source_version),
  CHECK (route=get_byte(uuid_send(thread_id),10)*256+get_byte(uuid_send(thread_id),11))
);
CREATE TABLE content.review_census_contribution (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  thread_id uuid NOT NULL,
  generation uuid NOT NULL,
  source_version text NOT NULL,
  eligible boolean NOT NULL,
  PRIMARY KEY(route,thread_id),
  FOREIGN KEY(route,thread_id,source_version) REFERENCES content.review_census_episode(route,thread_id,source_version)
);

-- migrate:down
DROP TABLE content.review_census_contribution;
DROP TABLE content.review_census_episode;
DROP TABLE content.review_census_installation;
