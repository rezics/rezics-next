-- migrate:up
-- Original Accounts ownership only. No historical enrollment, inventory seal or Source authority.
CREATE TABLE core.agent_identity_history_copy (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no) CHECK(partition_no BETWEEN 0 AND 4095),
  source_route integer NOT NULL CHECK(source_route BETWEEN 0 AND 65535),
  source_account_id uuid NOT NULL,
  source_direction text COLLATE "C" NOT NULL CHECK(source_direction IN ('account-agent.verify','account-agent.unverify')),
  source_receipt_id uuid NOT NULL,
  source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
  source_epoch integer NOT NULL CHECK(source_epoch>0),
  source_position bigint NOT NULL CHECK(source_position>0),
  source_transaction_id uuid NOT NULL,
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1')),
  locator bytea NOT NULL CHECK(octet_length(locator) BETWEEN 1 AND 256),
  writer_version integer NOT NULL CHECK(writer_version=1),
  receiver_epoch integer NOT NULL CHECK(receiver_epoch>0),
  domain_generation bigint NOT NULL CHECK(domain_generation>0),
  PRIMARY KEY(partition_no,source_route,source_account_id,source_direction,source_receipt_id,artifact_type,locator),
  CHECK(source_route=get_byte(uuid_send(source_account_id),10)*256+get_byte(uuid_send(source_account_id),11)),
  CHECK(partition_no=source_route/16),
  FOREIGN KEY(partition_no,source_route,source_account_id,artifact_type,locator)
    REFERENCES core.history_locator(partition_no,account_route,account_id,artifact_type,locator)
);
-- The exact receiving artifact invalidates all associated sources without searching owners.
CREATE INDEX agent_identity_history_copy_receiver ON core.agent_identity_history_copy
  (partition_no,artifact_type,locator,source_route,source_account_id,source_direction,source_receipt_id);

CREATE FUNCTION core.agent_identity_history_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; n integer := 0; phase text;
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Original Agent identity copy requires native retention discharge' USING ERRCODE='23514';
 END IF;
 -- SHARE the restore/routing generation and exact home through native COMMIT.
 PERFORM 1 FROM core.history_family_domain WHERE singleton AND generation=NEW.domain_generation FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agent identity history domain changed' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM core.partition WHERE partition_no=NEW.partition_no AND write_state='active'
   AND epoch=NEW.receiver_epoch AND epoch=NEW.source_epoch AND position=NEW.source_position FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Agent identity history home changed' USING ERRCODE='23514'; END IF;
 -- Every technical association is enrolled under the actual copy's complete native role union.
 FOR r IN SELECT account_route,account_id,state FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type=NEW.artifact_type AND locator=NEW.locator
   ORDER BY account_route,account_id LIMIT 65 FOR SHARE
 LOOP
   n:=n+1;
   IF n>64 OR r.state<>'pending' THEN
     RAISE EXCEPTION 'Agent identity history role union unavailable' USING ERRCODE='23514';
   END IF;
   SELECT s.phase INTO STRICT phase FROM core.history_seal s
     WHERE s.partition_no=NEW.partition_no AND s.account_route=r.account_route AND s.account_id=r.account_id FOR SHARE;
   IF phase<>'open' THEN RAISE EXCEPTION 'history account partition is sealed' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF n=0 THEN RAISE EXCEPTION 'Agent identity history role union unavailable' USING ERRCODE='23514'; END IF;
 PERFORM core.history_family_touch_artifact(NEW.partition_no,NEW.artifact_type,NEW.locator);
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_identity_history_copy_guard BEFORE INSERT OR UPDATE OR DELETE ON core.agent_identity_history_copy
 FOR EACH ROW EXECUTE FUNCTION core.agent_identity_history_copy_guard();

-- migrate:down
-- Forward only: actual serialized copies and their original associations cannot be unrecorded.
