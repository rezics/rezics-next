-- migrate:up
-- Preserve unproven bootstrap rows without inventing a creator. Public commands
-- always persist their authenticated principal as creator; those assignments
-- have immutable identity and issued validity. Database-owner fixture writes
-- to older/bootstrap evidence retain the existing read contract.
ALTER TABLE access.principal_assignment
  ADD COLUMN creator_principal_id uuid CHECK (creator_principal_id = principal_id),
  ADD COLUMN issued_valid tstzrange,
  ADD COLUMN revoked_at timestamptz;
UPDATE access.principal_assignment SET issued_valid = valid;
-- Revocation intersects the verifier's range with (-infinity,T). A future
-- assignment becomes empty; issued_valid retains the original [start,end).
ALTER TABLE access.principal_assignment
  ALTER COLUMN issued_valid SET NOT NULL,
  DROP CONSTRAINT principal_assignment_valid_check,
  ADD CONSTRAINT principal_assignment_valid_check CHECK (
    (revoked_at IS NOT NULL AND isempty(valid)) OR
    (NOT isempty(valid) AND (lower_inf(valid) OR lower_inc(valid)) AND NOT upper_inc(valid))
  );

CREATE FUNCTION access.guard_assignment_identity() RETURNS trigger
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
           AND (NEW.revoked_at IS DISTINCT FROM transaction_timestamp()
                OR NEW.valid IS DISTINCT FROM OLD.valid * tstzrange(NULL, transaction_timestamp(), '[)'))) THEN
      RAISE EXCEPTION 'Assignment identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assignment_identity BEFORE INSERT OR UPDATE ON access.principal_assignment
FOR EACH ROW EXECUTE FUNCTION access.guard_assignment_identity();

-- migrate:down
-- Forward only: immutable assignment provenance and revocation must be retained.
