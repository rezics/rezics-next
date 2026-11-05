-- migrate:up
-- Original identities and physical SDK workflow names are distinct, immutable native coordinates.
CREATE UNIQUE INDEX agent_identity_approval_original ON core.receipt(partition_no,transaction_id)
 WHERE principal_kind='account' AND command_kind='access.agent-verification.approve';
CREATE TABLE core.agent_identity_work (
 custody_id uuid PRIMARY KEY,
 workflow_id text COLLATE "C" NOT NULL UNIQUE CHECK(octet_length(workflow_id)<=256),
 source_key text COLLATE "C" NOT NULL UNIQUE CHECK(octet_length(source_key)<=256),
 approval jsonb CHECK(octet_length(approval::text)<=4096),
 source jsonb CHECK(octet_length(source::text)<=4096),
 accounts jsonb NOT NULL CHECK(jsonb_array_length(accounts) BETWEEN 1 AND 64),
 receiver_epoch integer NOT NULL CHECK(receiver_epoch>0),
 receiver_generation bigint NOT NULL CHECK(receiver_generation>0),
 writer_version integer NOT NULL DEFAULT 1 CHECK(writer_version=1),
 receiver_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 creation_captured boolean NOT NULL DEFAULT false,
 request_digest bytea CHECK(octet_length(request_digest)=32),
 CHECK(approval IS NOT NULL OR source IS NOT NULL)
);
-- Source-local association is written by the original source command, never by a new coordinator.
CREATE TABLE core.agent_identity_work_source (
 partition_no integer NOT NULL REFERENCES core.partition(partition_no),
 source_key text COLLATE "C" NOT NULL CHECK(octet_length(source_key)<=256),
 custody_id uuid NOT NULL UNIQUE,
 source jsonb NOT NULL CHECK(octet_length(source::text)<=4096),
 source_generation bigint NOT NULL CHECK(source_generation>0),
 writer_version integer NOT NULL DEFAULT 1 CHECK(writer_version=1),
 PRIMARY KEY(partition_no,source_key)
);
CREATE FUNCTION core.guard_agent_identity_work() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'native identity SDK custody is permanent' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='agent_identity_work_source' THEN
   RAISE EXCEPTION 'native identity SDK source intent is immutable' USING ERRCODE='23514';
 END IF;
 IF    (to_jsonb(NEW)-ARRAY['source','creation_captured','request_digest']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['source','creation_captured','request_digest']) OR
   (OLD.request_digest IS NOT NULL AND NEW.request_digest IS DISTINCT FROM OLD.request_digest) OR
   (OLD.source IS NOT NULL AND NEW.source IS DISTINCT FROM OLD.source) OR
   (OLD.creation_captured AND NOT NEW.creation_captured) THEN
   RAISE EXCEPTION 'native identity SDK custody is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_identity_work_immutable BEFORE UPDATE OR DELETE ON core.agent_identity_work
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();
CREATE TRIGGER agent_identity_work_source_immutable BEFORE UPDATE OR DELETE ON core.agent_identity_work_source
 FOR EACH ROW EXECUTE FUNCTION core.guard_agent_identity_work();
CREATE FUNCTION core.validate_agent_identity_work_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM access.agent_identity_intent i
   WHERE i.route=get_byte(uuid_send((NEW.source_key::jsonb->>1)::uuid),10)*256+
                 get_byte(uuid_send((NEW.source_key::jsonb->>1)::uuid),11)
     AND i.account_id=(NEW.source_key::jsonb->>1)::uuid
     AND i.direction=NEW.source_key::jsonb->>0 AND i.receipt_id=(NEW.source_key::jsonb->>2)::uuid
     AND i.source_partition=NEW.partition_no AND i.source_epoch=(NEW.source->>'epoch')::integer
     AND i.source_position=(NEW.source->>'position')::bigint
     AND i.source_transaction_id=(NEW.source->>'transactionId')::uuid
     AND i.intent_digest=NEW.source->>'digest' AND i.release=NEW.source->>'release'
     AND i.workflow_id=NEW.source->>'workflowId'
     AND i.xmin::text=pg_current_xact_id()::text
 ) OR NEW.source_key<>NEW.source->>'key' OR NEW.partition_no<>(NEW.source->>'partition')::integer THEN
   RAISE EXCEPTION 'SDK association lacks actual original Account source command' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER agent_identity_work_source_native AFTER INSERT ON core.agent_identity_work_source
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.validate_agent_identity_work_source();

-- migrate:down
DROP TABLE core.agent_identity_work_source;
DROP TABLE core.agent_identity_work;
DROP FUNCTION core.validate_agent_identity_work_source();
DROP FUNCTION core.guard_agent_identity_work();
DROP INDEX core.agent_identity_approval_original;
