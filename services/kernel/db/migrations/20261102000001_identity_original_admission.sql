-- migrate:up
-- Fixed Accounts original controls. These are not an allocation service or a custody ACK.
CREATE FUNCTION core.identity_original_vector_valid(v bigint[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE AS $$
 SELECT array_ndims(v)=1 AND array_lower(v,1)=1 AND cardinality(v)=8
   AND NOT EXISTS(SELECT 1 FROM unnest(v) n WHERE n IS NULL OR n<0 OR n>9007199254740991)
$$;

CREATE TABLE core.identity_history_original (
 original_id uuid PRIMARY KEY,
 ordinal bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 job_id uuid NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=2048),
 deadline bigint NOT NULL CHECK(deadline BETWEEN 1 AND 9007199254740991),
 allowance bigint[] NOT NULL CHECK(core.identity_original_vector_valid(allowance)),
 spent bigint[] NOT NULL CHECK(core.identity_original_vector_valid(spent)),
 dispatched boolean NOT NULL DEFAULT false,
 advanced boolean NOT NULL DEFAULT false,
 CHECK(binding->>'job_id'=job_id::text),
 CHECK(NOT advanced OR dispatched),
 CHECK(spent[1]<=allowance[1] AND spent[2]<=allowance[2] AND spent[3]<=allowance[3]
   AND spent[4]<=allowance[4] AND spent[5]<=allowance[5] AND spent[6]<=allowance[6]
   AND spent[7]<=allowance[7] AND spent[8]<=allowance[8])
);
CREATE INDEX identity_history_original_job ON core.identity_history_original(job_id,ordinal DESC);

CREATE TABLE core.identity_fx_original (
 original_id uuid PRIMARY KEY,
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 epoch integer NOT NULL CHECK(epoch>0),
 position bigint NOT NULL CHECK(position>0),
 event_seq integer NOT NULL CHECK(event_seq BETWEEN 0 AND 999),
 effect text NOT NULL CHECK(effect='agent_verification_reversal'),
 workflow_id text COLLATE "C" NOT NULL UNIQUE CHECK(octet_length(workflow_id)<=256),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=32768),
 deadline bigint NOT NULL CHECK(deadline BETWEEN 1 AND 9007199254740991),
 allowance bigint[] NOT NULL CHECK(core.identity_original_vector_valid(allowance)),
 spent bigint[] NOT NULL CHECK(core.identity_original_vector_valid(spent)),
 UNIQUE(partition_no,epoch,position,event_seq,effect),
 CHECK(spent[1]<=allowance[1] AND spent[2]<=allowance[2] AND spent[3]<=allowance[3]
   AND spent[4]<=allowance[4] AND spent[5]<=allowance[5] AND spent[6]<=allowance[6]
   AND spent[7]<=allowance[7] AND spent[8]<=allowance[8])
);

-- Receiving is a separate home-zero command after the source checkout has been released.
-- It records the real original, not the reversal child's custody identity.
CREATE TABLE core.identity_fx_receiving (
 workflow_id text COLLATE "C" PRIMARY KEY CHECK(octet_length(workflow_id)<=256),
 original_id uuid NOT NULL UNIQUE,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object' AND octet_length(binding::text)<=32768),
 receiver_epoch integer NOT NULL CHECK(receiver_epoch>0),
 receiver_generation bigint NOT NULL CHECK(receiver_generation>0),
 deadline bigint NOT NULL CHECK(deadline BETWEEN 1 AND 9007199254740991),
 writer_state text NOT NULL DEFAULT 'pending-physical-owner' CHECK(writer_state='pending-physical-owner'),
 allowance bigint[] NOT NULL CHECK(core.identity_original_vector_valid(allowance)),
 spent bigint[] NOT NULL CHECK(core.identity_original_vector_valid(spent)),
 CHECK(spent[1]<=allowance[1] AND spent[2]<=allowance[2] AND spent[3]<=allowance[3]
   AND spent[4]<=allowance[4] AND spent[5]<=allowance[5] AND spent[6]<=allowance[6]
   AND spent[7]<=allowance[7] AND spent[8]<=allowance[8])
);

CREATE FUNCTION core.guard_identity_original_control() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i integer; mutable text[];
BEGIN
 IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'Original admission retains unresolved custody' USING ERRCODE='23514';
 END IF;
 mutable:=CASE WHEN TG_TABLE_NAME='identity_history_original'
   THEN ARRAY['spent','dispatched','advanced'] ELSE ARRAY['spent'] END;
 IF (to_jsonb(NEW)-mutable) IS DISTINCT FROM (to_jsonb(OLD)-mutable) THEN
   RAISE EXCEPTION 'Original admission identity and ceiling are immutable' USING ERRCODE='23514';
 END IF;
 FOR i IN 1..8 LOOP
   IF NEW.spent[i]<OLD.spent[i] THEN
     RAISE EXCEPTION 'Original admission cannot refund consumed work' USING ERRCODE='23514';
   END IF;
 END LOOP;
 IF TG_TABLE_NAME='identity_history_original' THEN
   IF (OLD.dispatched AND NOT NEW.dispatched) OR (OLD.advanced AND NOT NEW.advanced) THEN
     RAISE EXCEPTION 'Original admission cannot reopen' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_history_original_guard BEFORE UPDATE OR DELETE ON core.identity_history_original
 FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();
CREATE TRIGGER identity_fx_original_guard BEFORE UPDATE OR DELETE ON core.identity_fx_original
 FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();
CREATE TRIGGER identity_fx_receiving_guard BEFORE UPDATE OR DELETE ON core.identity_fx_receiving
 FOR EACH ROW EXECUTE FUNCTION core.guard_identity_original_control();

-- migrate:down
-- Forward only: neither replay nor workflow completion erases an original obligation.
