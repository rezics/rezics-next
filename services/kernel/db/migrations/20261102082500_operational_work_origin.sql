-- migrate:up
-- The installed log requires an event at every position. Operational registration records an
-- authentic same-transaction association, with the unavailable original log position explicit.
CREATE TABLE core.operational_work_original (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  custody_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  workflow_id text COLLATE "C" NOT NULL CHECK(octet_length(workflow_id)<=256),
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  binding jsonb NOT NULL CHECK(octet_length(binding::text)<=262144),
  intent jsonb NOT NULL CHECK(octet_length(intent::text)<=8192),
  scope jsonb NOT NULL CHECK(octet_length(scope::text)<=4096 AND jsonb_array_length(scope->'accounts') BETWEEN 1 AND 8),
  operation_kind text NOT NULL CHECK(operation_kind='library.membersPreparation'),
  operation_mode text NOT NULL CHECK(operation_mode='request'),
  operation_accounts jsonb NOT NULL CHECK(jsonb_array_length(operation_accounts)=1),
  deadline bigint NOT NULL CHECK(deadline>0),
  source_generation bigint NOT NULL CHECK(source_generation>0),
  source_epoch integer CHECK(source_epoch>0),
  source_position bigint CHECK(source_position IS NULL),
  sealed boolean NOT NULL DEFAULT false,
  log_gap text NOT NULL DEFAULT 'operational-work-original-log-position-unavailable'
    CHECK(log_gap='operational-work-original-log-position-unavailable'),
  creation_captured boolean NOT NULL,
  sdk_writer jsonb NOT NULL CHECK(octet_length(sdk_writer::text)<=1024),
  sdk_creator text CHECK(octet_length(sdk_creator)<=256),
  sdk_input_digest bytea NOT NULL CHECK(octet_length(sdk_input_digest)=32),
  PRIMARY KEY(partition_no,custody_id),
  UNIQUE(partition_no,workflow_id),
  UNIQUE(partition_no,transaction_id),
  UNIQUE(partition_no,source_epoch,source_position),
  CHECK((source_epoch IS NOT NULL)=sealed),
  CHECK(source_position IS NULL),
  CHECK(NOT creation_captured OR sdk_creator IS NOT NULL),
  CHECK(partition_no=((binding->>'route')::integer >> 4)),
  CHECK(operation_accounts=jsonb_build_array(binding->>'ownerAccountId'))
);
CREATE TABLE core.operational_work_episode (
  partition_no integer NOT NULL,
  route integer NOT NULL CHECK(route BETWEEN 0 AND 65535 AND partition_no=(route >> 4)),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  custody_id uuid NOT NULL,
  PRIMARY KEY(partition_no,route,owner_account_id,collection_id,episode_id),
  FOREIGN KEY(partition_no,custody_id) REFERENCES core.operational_work_original(partition_no,custody_id),
  CHECK(route=get_byte(uuid_send(owner_account_id),10)*256+get_byte(uuid_send(owner_account_id),11)),
  CHECK(route=get_byte(uuid_send(collection_id),10)*256+get_byte(uuid_send(collection_id),11)),
  CHECK(route=get_byte(uuid_send(episode_id),10)*256+get_byte(uuid_send(episode_id),11))
);
-- The receiving home owns this inventory independently. No cross-home FK or identity-owned row.
CREATE TABLE core.operational_work_mapping (
  partition_no integer NOT NULL DEFAULT 0 REFERENCES core.partition(partition_no) CHECK(partition_no=0),
  custody_id uuid NOT NULL,
  workflow_id text COLLATE "C" NOT NULL CHECK(octet_length(workflow_id)<=256),
  source_partition integer NOT NULL CHECK(source_partition BETWEEN 0 AND 4095),
  source_transaction uuid NOT NULL,
  source_epoch integer NOT NULL CHECK(source_epoch>0),
  source_position bigint CHECK(source_position IS NULL),
  log_gap text NOT NULL DEFAULT 'operational-work-original-log-position-unavailable'
    CHECK(log_gap='operational-work-original-log-position-unavailable'),
  source_generation bigint NOT NULL CHECK(source_generation>0),
  request_digest bytea NOT NULL CHECK(octet_length(request_digest)=32),
  source jsonb NOT NULL CHECK(octet_length(source::text)<=278528),
  receiver_epoch integer NOT NULL CHECK(receiver_epoch>0),
  receiver_generation bigint NOT NULL CHECK(receiver_generation>0),
  sdk_writer jsonb NOT NULL CHECK(octet_length(sdk_writer::text)<=1024),
  PRIMARY KEY(partition_no,custody_id),
  UNIQUE(partition_no,workflow_id)
);

CREATE FUNCTION core.operational_work_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'operational History identity is permanent' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='operational_work_original' AND NOT OLD.sealed AND NEW.sealed AND
     (to_jsonb(OLD)-ARRAY['source_epoch','sealed'])=(to_jsonb(NEW)-ARRAY['source_epoch','sealed']) THEN
    RETURN NEW;
  END IF;
  IF OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'operational History identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_original_immutable BEFORE UPDATE OR DELETE ON core.operational_work_original
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();
CREATE TRIGGER operational_work_episode_immutable BEFORE UPDATE OR DELETE ON core.operational_work_episode
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();
CREATE TRIGGER operational_work_mapping_immutable BEFORE UPDATE OR DELETE ON core.operational_work_mapping
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_immutable();
CREATE TRIGGER operational_work_original_no_truncate BEFORE TRUNCATE ON core.operational_work_original
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();
CREATE TRIGGER operational_work_episode_no_truncate BEFORE TRUNCATE ON core.operational_work_episode
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();
CREATE TRIGGER operational_work_mapping_no_truncate BEFORE TRUNCATE ON core.operational_work_mapping
  FOR EACH STATEMENT EXECUTE FUNCTION core.operational_work_immutable();

CREATE FUNCTION core.operational_work_require_native_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o core.operational_work_original;
BEGIN
  -- Deferred INSERT sees the row sealed by the executor, not the unsealed trigger NEW value.
  SELECT * INTO STRICT o FROM core.operational_work_original
    WHERE partition_no=NEW.partition_no AND custody_id=NEW.custody_id;
  IF NOT o.sealed OR o.source_epoch IS NULL THEN
    RAISE EXCEPTION 'operational-work-native-commit-fence-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER operational_work_require_native_seal AFTER INSERT ON core.operational_work_original
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.operational_work_require_native_seal();

CREATE FUNCTION core.operational_work_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.artifact_type='durable-work/v1' AND substring(OLD.locator FROM 3 FOR 9)=convert_to('6f70776b-','UTF8') AND
       (OLD.partition_no,OLD.account_route,OLD.account_id,OLD.artifact_type,OLD.locator,OLD.roles,OLD.minimizer_version)
       IS DISTINCT FROM
       (NEW.partition_no,NEW.account_route,NEW.account_id,NEW.artifact_type,NEW.locator,NEW.roles,NEW.minimizer_version) THEN
      RAISE EXCEPTION 'operational History original roles are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.artifact_type<>'durable-work/v1' OR substring(NEW.locator FROM 3 FOR 9)<>convert_to('6f70776b-','UTF8') THEN RETURN NEW; END IF;
  SELECT o.scope INTO scope FROM core.operational_work_original o
    WHERE o.partition_no=NEW.partition_no AND o.custody_id=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid FOR SHARE;
  IF NOT FOUND THEN
    SELECT m.source->'scope' INTO scope FROM core.operational_work_mapping m
      WHERE m.partition_no=NEW.partition_no AND m.custody_id=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid FOR SHARE;
  END IF;
  IF scope IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM jsonb_to_recordset(scope->'accounts') a("accountRoute" integer,"accountId" uuid,roles integer)
    WHERE a."accountRoute"=NEW.account_route AND a."accountId"=NEW.account_id AND a.roles=NEW.roles) THEN
    RAISE EXCEPTION 'operational History original roles differ' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_role_guard BEFORE INSERT OR UPDATE ON core.history_locator
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_role_guard();

-- Generic History cannot mistake an absent SDK UUID row for absence of a mapped named workflow.
-- These controls remain closed until the independent Source/final receiving owner operand exists.
CREATE FUNCTION core.operational_work_custody_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE id uuid; p integer; own boolean;
BEGIN
  IF TG_TABLE_NAME='history_work' THEN
    IF TG_OP='DELETE' THEN
      IF OLD.owner='library.members-preparation' THEN
        RAISE EXCEPTION 'operational History inventory is permanent' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.owner IS DISTINCT FROM 'library.members-preparation' AND
       (TG_OP='INSERT' OR OLD.owner IS DISTINCT FROM 'library.members-preparation') THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND
       (to_jsonb(OLD)-ARRAY['state','owner_ready','retired_at','absence_verified']) IS DISTINCT FROM
       (to_jsonb(NEW)-ARRAY['state','owner_ready','retired_at','absence_verified']) THEN
      RAISE EXCEPTION 'operational History original inventory is immutable' USING ERRCODE='23514';
    END IF;
    id:=NEW.work_id; p:=NEW.partition_no;
    IF NOT (NEW.state='retired' OR NEW.absence_verified OR NEW.owner_ready) THEN RETURN NEW; END IF;
  ELSE
    IF TG_OP='DELETE' THEN
      IF OLD.artifact_type='durable-work/v1' AND substring(OLD.locator FROM 3 FOR 9)=convert_to('6f70776b-','UTF8') THEN
        RAISE EXCEPTION 'operational History inventory is permanent' USING ERRCODE='23514';
      END IF;
      RETURN OLD;
    END IF;
    IF NEW.artifact_type<>'durable-work/v1' THEN RETURN NEW; END IF;
    -- Namespace selects a probe only; the exact durable records below supply authority.
    IF substring(NEW.locator FROM 3 FOR 9)<>convert_to('6f70776b-','UTF8') THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='history_locator' AND NEW.state<>'minimized' THEN RETURN NEW; END IF;
    BEGIN id:=convert_from(substring(NEW.locator FROM 3),'UTF8')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RETURN NEW; END;
    p:=NEW.partition_no;
  END IF;
  SELECT EXISTS(SELECT 1 FROM core.operational_work_original WHERE partition_no=p AND custody_id=id)
    OR EXISTS(SELECT 1 FROM core.operational_work_mapping WHERE partition_no=p AND custody_id=id) INTO own;
  IF own THEN
    RAISE EXCEPTION 'operational-work-source-currentness-unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER operational_work_custody_guard BEFORE INSERT OR UPDATE OR DELETE ON core.history_work
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();
CREATE TRIGGER operational_work_locator_guard BEFORE UPDATE OR DELETE ON core.history_locator
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();
CREATE TRIGGER operational_work_receiving_guard BEFORE INSERT ON core.history_receiving_proof
  FOR EACH ROW EXECUTE FUNCTION core.operational_work_custody_guard();
ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_original_immutable;
ALTER TABLE core.operational_work_episode ENABLE ALWAYS TRIGGER operational_work_episode_immutable;
ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_immutable;
ALTER TABLE core.operational_work_original ENABLE ALWAYS TRIGGER operational_work_original_no_truncate;
ALTER TABLE core.operational_work_episode ENABLE ALWAYS TRIGGER operational_work_episode_no_truncate;
ALTER TABLE core.operational_work_mapping ENABLE ALWAYS TRIGGER operational_work_mapping_no_truncate;
ALTER TABLE core.history_work ENABLE ALWAYS TRIGGER operational_work_custody_guard;
ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER operational_work_role_guard;
ALTER TABLE core.history_locator ENABLE ALWAYS TRIGGER operational_work_locator_guard;
ALTER TABLE core.history_receiving_proof ENABLE ALWAYS TRIGGER operational_work_receiving_guard;

-- migrate:down
-- Forward only: the immutable original and retirement obligations survive SDK deduplication loss.
