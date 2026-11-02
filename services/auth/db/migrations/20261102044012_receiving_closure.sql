-- migrate:up
-- Local work is never the independent physical-owner authority. A copied receipt
-- can be used only through its exact currently bound Access receiving control.
CREATE TABLE auth_receiving_work (
 obligation_id bigint NOT NULL REFERENCES auth_erasure(id),
 control_revision bigint NOT NULL,
 binding jsonb NOT NULL CHECK(octet_length(binding::text)<=1024),
 restore_generation text,
 native_xid xid8,
 closure_receipt_id uuid,
 closure_xid xid8,
 PRIMARY KEY(obligation_id,control_revision),
 CHECK((closure_receipt_id IS NULL)=(closure_xid IS NULL))
);
CREATE TABLE auth_receiving_copy (
 obligation_id bigint NOT NULL,
 control_revision bigint NOT NULL,
 workflow_id text NOT NULL CHECK(octet_length(workflow_id)<=1024),
 sdk_closure_id uuid NOT NULL,
 sdk_closed_at bigint NOT NULL,
 native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 PRIMARY KEY(obligation_id,control_revision,workflow_id),
 FOREIGN KEY(obligation_id,control_revision) REFERENCES auth_receiving_work
);
CREATE FUNCTION auth_receiving_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving work is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.native_xid IS NOT NULL OR NEW.closure_receipt_id IS NOT NULL OR NEW.closure_xid IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving work must start without completion';
  END IF;
 ELSE
  IF (NEW.obligation_id,NEW.control_revision,NEW.binding,NEW.restore_generation)
   IS DISTINCT FROM (OLD.obligation_id,OLD.control_revision,OLD.binding,OLD.restore_generation)
   OR (OLD.native_xid IS NOT NULL AND NEW.native_xid IS NULL)
   OR (OLD.closure_receipt_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Auth receiving work cannot replace its binding or completed receipt';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER auth_receiving_work_guard BEFORE INSERT OR UPDATE OR DELETE ON auth_receiving_work
 FOR EACH ROW EXECUTE FUNCTION auth_receiving_work_guard();
CREATE FUNCTION auth_receiving_copy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Auth receiving SDK receipt is immutable'; END $$;
CREATE TRIGGER auth_receiving_copy_immutable BEFORE UPDATE OR DELETE ON auth_receiving_copy
 FOR EACH ROW EXECUTE FUNCTION auth_receiving_copy_immutable();
-- migrate:down
-- Forward-only native custody evidence.
