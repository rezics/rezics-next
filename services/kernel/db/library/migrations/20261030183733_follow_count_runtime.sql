-- migrate:up
ALTER TABLE library.follow_count_owner
  ADD COLUMN bootstrap_after uuid,
  ADD COLUMN bootstrap_upper uuid,
  ADD COLUMN bootstrap_started boolean NOT NULL DEFAULT false,
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED;
CREATE INDEX follow_count_owner_bootstrap ON library.follow_count_owner(partition_no, route, account_id)
  WHERE NOT bootstrap_complete;
ALTER TABLE library.follow_count_source
  ADD COLUMN partition_no integer GENERATED ALWAYS AS (route >> 4) STORED;
CREATE INDEX follow_count_source_original_page ON library.follow_count_source(route,account_id,target_id,target_type);
CREATE INDEX follow_count_partition_pending ON library.follow_count_source(partition_no, pending_since, route, account_id, target_type, target_id)
  WHERE pending_since IS NOT NULL;

CREATE TABLE library.follow_count_total (
  route integer NOT NULL,
  target_type text NOT NULL CHECK(target_type IN ('subject','collection','space')),
  target_id uuid NOT NULL,
  total bigint NOT NULL DEFAULT 0 CHECK(total >= 0),
  PRIMARY KEY(route,target_type,target_id)
);
CREATE TABLE library.follow_count_support (
  route integer NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  account_id uuid NOT NULL,
  support bigint NOT NULL CHECK(support >= 0),
  PRIMARY KEY(route,target_type,target_id,account_id)
);
CREATE TABLE library.follow_count_pair (
  route integer NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  account_id uuid NOT NULL,
  original_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision > 0),
  eligible boolean NOT NULL,
  PRIMARY KEY(route,target_type,target_id,account_id,original_id)
);
CREATE INDEX follow_count_pair_original ON library.follow_count_pair(route,original_id,account_id,target_type,target_id);
CREATE INDEX follow_count_pair_follower ON library.follow_count_pair(route,account_id,target_type,target_id,original_id);
-- Source-home exact receiving locators survive target commit before source ACK.
CREATE TABLE library.follow_count_destination (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  target_type text NOT NULL,
  original_id uuid NOT NULL,
  destination_route integer NOT NULL,
  destination_id uuid NOT NULL,
  PRIMARY KEY(route,account_id,target_type,original_id,destination_route,destination_id)
);
CREATE TABLE library.follow_count_terminal_follower (
  partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
  account_id uuid NOT NULL,
  PRIMARY KEY(partition_no,account_id)
);
CREATE TABLE library.follow_count_account_work (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
  after_id uuid,
  scan_complete boolean NOT NULL DEFAULT false,
  oldest_pending_at timestamptz NOT NULL,
  PRIMARY KEY(route,account_id)
);
CREATE INDEX follow_count_account_pending ON library.follow_count_account_work((route >> 4),oldest_pending_at,route,account_id);
-- Stable source-owner discovery and native target initialization use bounded raw-key pages.
CREATE TABLE library.follow_count_partition (
  partition_no integer PRIMARY KEY,
  owner_route integer,
  owner_id uuid,
  discovery_started boolean NOT NULL DEFAULT false,
  upper_route integer,
  upper_owner uuid,
  opened boolean NOT NULL DEFAULT false,
  source_complete boolean NOT NULL DEFAULT false,
  target_kind integer NOT NULL DEFAULT 0 CHECK(target_kind BETWEEN 0 AND 3),
  target_after uuid,
  target_route integer,
  target_upper_route integer,
  target_upper uuid,
  target_started boolean NOT NULL DEFAULT false,
  sampled_at timestamptz,
  oldest_pending_at timestamptz
);
INSERT INTO library.follow_count_partition(partition_no) SELECT partition_no FROM core.partition;
CREATE TABLE library.follow_count_health (
  node integer PRIMARY KEY CHECK(node BETWEEN 0 AND 4368),
  sampled_at timestamptz,
  oldest_pending_at timestamptz,
  members integer NOT NULL DEFAULT 0 CHECK(members >= 0),
  ready boolean NOT NULL DEFAULT false
);
INSERT INTO library.follow_count_health(node) SELECT generate_series(0,4368);
-- Payload-free terminal admission survives late relay replay after local cleanup.
CREATE TABLE library.follow_count_terminal_source (
    partition_no integer NOT NULL REFERENCES core.partition(partition_no),
    account_id uuid NOT NULL,
    local_complete boolean NOT NULL DEFAULT false,
    oldest_pending_at timestamptz,
    CHECK(local_complete OR oldest_pending_at IS NOT NULL),
    PRIMARY KEY(partition_no,account_id)
);
CREATE INDEX follow_count_terminal_source_pending ON library.follow_count_terminal_source
    (partition_no,oldest_pending_at,account_id) WHERE NOT local_complete;

CREATE TABLE library.follow_count_account_signal (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY(route,account_id,event_id)
);
-- The topology has 4096 leaf slots, fanout 16, depth three. Installing a
-- physical source invalidates its path in the same native partition transaction.
CREATE FUNCTION library.install_follow_count_partition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_node integer; added integer;
BEGIN
  INSERT INTO library.follow_count_partition(partition_no) VALUES(NEW.partition_no)
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  IF added > 0 THEN
    current_node := 273 + NEW.partition_no;
    LOOP
      UPDATE library.follow_count_health SET members=members+1,ready=false,sampled_at=NULL WHERE node=current_node;
      EXIT WHEN current_node=0;
      current_node := (current_node-1)/16;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER follow_count_source_topology AFTER INSERT ON core.partition
  FOR EACH ROW EXECUTE FUNCTION library.install_follow_count_partition();
DO $$
DECLARE part integer; current_node integer;
BEGIN
  FOR part IN SELECT partition_no FROM library.follow_count_partition LOOP
    current_node := 273 + part;
    LOOP
      UPDATE library.follow_count_health SET members=members+1 WHERE node=current_node;
      EXIT WHEN current_node=0;
      current_node := (current_node-1)/16;
    END LOOP;
  END LOOP;
END $$;
-- Creation initializes a true native zero; legacy targets use bounded backfill.
CREATE FUNCTION library.initialize_follow_count_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; identity uuid;
BEGIN
  IF TG_TABLE_SCHEMA = 'semantic' THEN kind := 'subject'; identity := NEW.subject_id;
  ELSIF TG_TABLE_SCHEMA = 'community' THEN kind := 'space'; identity := NEW.space_id;
  ELSE kind := 'collection'; identity := NEW.collection_id;
  END IF;
  INSERT INTO library.follow_count_total(route,target_type,target_id) VALUES(NEW.route,kind,identity)
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER follow_count_new_subject AFTER INSERT ON semantic.subject
  FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();
CREATE TRIGGER follow_count_new_space AFTER INSERT ON community.space
  FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();
CREATE TRIGGER follow_count_new_collection AFTER INSERT ON library.collection
  FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_total();

CREATE FUNCTION library.initialize_follow_count_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO library.follow_count_owner(route,account_id,bootstrap_complete,bootstrap_started)
    VALUES(NEW.route,NEW.account_id,true,true) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER follow_count_new_account AFTER INSERT ON access.account
  FOR EACH ROW EXECUTE FUNCTION library.initialize_follow_count_owner();

-- migrate:down
-- Forward only: source revisions, negative pairs and terminal fences cannot be reset.
