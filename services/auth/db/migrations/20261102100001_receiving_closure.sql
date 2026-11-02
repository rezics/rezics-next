-- migrate:up
CREATE OR REPLACE FUNCTION auth_receiving_work_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving work is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.native_xid IS NOT NULL OR NEW.closure_receipt_id IS NOT NULL OR NEW.closure_xid IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving work must start without completion';
  END IF;
 ELSE
  IF (NEW.obligation_id,NEW.control_revision,NEW.binding,NEW.restore_generation)
   IS DISTINCT FROM (OLD.obligation_id,OLD.control_revision,OLD.binding,OLD.restore_generation)
   OR (OLD.native_xid IS NOT NULL AND NEW.native_xid IS DISTINCT FROM OLD.native_xid)
   OR (NEW.native_xid IS NOT NULL AND OLD.native_xid IS NULL AND NEW.native_xid<>pg_current_xact_id())
   OR (NEW.closure_xid IS NOT NULL AND OLD.closure_xid IS NULL AND NEW.closure_xid<>pg_current_xact_id())
   OR (OLD.closure_receipt_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Auth receiving work cannot replace its binding or completed receipt';
  END IF;
 END IF;
 RETURN NEW;
END $$;
-- migrate:down
-- Forward-only immutable completion transaction identity.
