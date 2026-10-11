ALTER TABLE access.command_custody
  ALTER COLUMN payload DROP NOT NULL,
  ADD COLUMN payload_erasure_id uuid,
  ADD COLUMN payload_erasure_epoch bigint,
  ADD CONSTRAINT command_custody_payload_erasure CHECK (
    (payload IS NULL) = (payload_erasure_id IS NOT NULL)
    AND (payload IS NULL) = (payload_erasure_epoch IS NOT NULL)
    AND (payload_erasure_epoch IS NULL OR payload_erasure_epoch > 0)
  );

CREATE FUNCTION access.guard_command_custody_erasure() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'command custody receipts are retained';
  END IF;

  IF ROW(NEW.receipt, NEW.request_digest, NEW.payload_sha256, NEW.revision)
    IS DISTINCT FROM ROW(OLD.receipt, OLD.request_digest, OLD.payload_sha256, OLD.revision) THEN
    RAISE EXCEPTION 'command custody identity is immutable';
  END IF;

  IF OLD.payload_erasure_id IS NOT NULL THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'erased command custody is terminal';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW.payload, NEW.payload_erasure_id, NEW.payload_erasure_epoch)
    IS DISTINCT FROM ROW(OLD.payload, OLD.payload_erasure_id, OLD.payload_erasure_epoch) THEN
    IF OLD.payload IS NULL OR NEW.payload IS NOT NULL
      OR NEW.payload_erasure_id IS NULL OR NEW.payload_erasure_epoch IS NULL
      OR ROW(NEW.terminal, NEW.outbox, NEW.reconciled_at, NEW.retired_at, NEW.data_epoch, NEW.stream_sequence)
        IS DISTINCT FROM ROW(OLD.terminal, OLD.outbox, OLD.reconciled_at, OLD.retired_at, OLD.data_epoch, OLD.stream_sequence) THEN
      RAISE EXCEPTION 'command custody payload can only be cleared with its terminal erasure';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER command_custody_erasure_guard
  BEFORE UPDATE OR DELETE ON access.command_custody
  FOR EACH ROW EXECUTE FUNCTION access.guard_command_custody_erasure();
