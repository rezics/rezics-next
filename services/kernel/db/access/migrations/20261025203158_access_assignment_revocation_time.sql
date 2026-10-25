-- migrate:up
-- The command supplies authoritative T; the guard checks row consistency.
CREATE OR REPLACE FUNCTION access.guard_assignment_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR (NEW.issued_valid IS NOT NULL AND NEW.issued_valid IS DISTINCT FROM NEW.valid) THEN
      RAISE EXCEPTION 'Assignment must begin with its original validity' USING ERRCODE = '23514';
    END IF;
    NEW.issued_valid := NEW.valid;
  ELSE
    IF ROW(NEW.route, NEW.principal_id, NEW.request_id, NEW.creator_principal_id, NEW.issued_valid, NEW.transaction_id)
       IS DISTINCT FROM
       ROW(OLD.route, OLD.principal_id, OLD.request_id, OLD.creator_principal_id, OLD.issued_valid, OLD.transaction_id)
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.assigned_actor_id IS DISTINCT FROM OLD.assigned_actor_id)
       OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.valid) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.valid))
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.revoked_at IS NULL AND NEW.valid IS DISTINCT FROM OLD.valid)
       OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
           AND NEW.valid IS DISTINCT FROM OLD.valid * tstzrange(NULL, NEW.revoked_at, '[)')) THEN
      RAISE EXCEPTION 'Assignment identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: revocation must retain its authoritative command time.
