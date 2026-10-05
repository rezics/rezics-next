-- Scope epochs fence scope policy/closure. Object proofs retain the exact row
-- generations instead; a Realm join cannot fence unrelated Work commands.
ALTER TABLE access.admission ADD COLUMN authority_witness jsonb;
ALTER TABLE access.admission ADD CONSTRAINT admission_authority_witness_bounded CHECK (
  authority_witness IS NULL OR (jsonb_typeof(authority_witness) = 'array'
    AND jsonb_array_length(authority_witness) >= 1));

-- The active profile already owns group depth; a second fixed row cap must
-- never reject an authority path that the installed profile supports.
CREATE FUNCTION access.guard_admission_authority_witness() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE depth integer; sources integer; ancestors integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.authority_witness IS NOT NULL
    AND NEW.authority_witness IS DISTINCT FROM OLD.authority_witness THEN
    RAISE EXCEPTION 'admission authority witness is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.authority_witness IS NULL THEN RETURN NEW; END IF;
  SELECT count(*) FILTER (WHERE w->>'table' <> 'recipient_group'),
    count(*) FILTER (WHERE w->>'table' = 'recipient_group') INTO sources,ancestors
    FROM jsonb_array_elements(NEW.authority_witness) w;
  SELECT p.group_depth INTO depth FROM access.operational_bounds_activation a
    JOIN access.operational_bounds_profile p ON p.id = a.profile_id WHERE a.singleton;
  IF sources > 16 OR ancestors > depth + 1 THEN
    RAISE EXCEPTION 'admission authority witness exceeds active profile' USING ERRCODE = '54000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admission_authority_witness_guard BEFORE INSERT OR UPDATE OF authority_witness
  ON access.admission FOR EACH ROW EXECUTE FUNCTION access.guard_admission_authority_witness();

-- Preserve the group management inventory revision without writing the Work
-- dispatch fence. Admissions pin only their selected roster/grant/ancestry.
INSERT INTO access.scope_gate(id,group_generation)
  SELECT 'access:group-inventory',group_generation FROM access.scope_gate WHERE id = 'work:create:root';
CREATE OR REPLACE FUNCTION access.bump_group_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.scope_gate SET group_generation = group_generation + 1 WHERE id = 'access:group-inventory';
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION access.guard_group_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyclic boolean;
BEGIN
  PERFORM 1 FROM access.scope_gate WHERE id = 'access:group-inventory' FOR UPDATE;
  IF NEW.parent_id IS NOT NULL THEN
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM access.recipient_group WHERE id = NEW.parent_id
      UNION SELECT p.id,p.parent_id FROM access.recipient_group p JOIN ancestors a ON p.id = a.parent_id
    ) SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = NEW.id) INTO cyclic;
    IF cyclic THEN RAISE EXCEPTION 'recipient group cycle' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recipient_group_generation_advance BEFORE UPDATE ON access.recipient_group
  FOR EACH ROW EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER group_member_generation_advance BEFORE UPDATE ON access.group_member
  FOR EACH ROW EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER group_grant_generation_advance BEFORE UPDATE ON access.group_permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.advance_authority_generation();

-- Controller continuity belongs to one Agent. Statement-wide Work locks made
-- an unrelated controller departure block every ordinary Access command.
DROP TRIGGER representation_controller_lock ON access.representation;
CREATE FUNCTION access.lock_agent_controller() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action = 'agent.control' OR NEW.action = 'agent.control' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-controller:' || NEW.subject_id,0));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER representation_controller_lock BEFORE UPDATE ON access.representation
  FOR EACH ROW EXECUTE FUNCTION access.lock_agent_controller();
CREATE OR REPLACE FUNCTION access.lock_representation_gates() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM access.scope_gate WHERE id = 'work:create:root' FOR SHARE;
  PERFORM 1 FROM access.scope_gate WHERE id = 'access:representation-topology' FOR UPDATE;
  RETURN NULL;
END $$;
DROP TRIGGER representation_controller_work_fence ON access.representation;
DROP TRIGGER representation_edge_controller_work_fence ON access.representation_edge;
DROP FUNCTION access.fence_agent_controller_work();

-- A source revocation can occur while its scope has never been closed. The
-- revoked source generation is positive; the independent scope epoch may be 0.
ALTER TABLE access.revocation DROP CONSTRAINT revocation_fence_authority_epoch_check;
ALTER TABLE access.revocation ADD CONSTRAINT revocation_fence_authority_epoch_check CHECK (fence_authority_epoch >= 0);
ALTER TABLE access.revocation_receipt DROP CONSTRAINT revocation_receipt_result_authority_epoch_check;
ALTER TABLE access.revocation_receipt ADD CONSTRAINT revocation_receipt_result_authority_epoch_check CHECK (result_authority_epoch >= 0);
ALTER TABLE access.org_realm_move DROP CONSTRAINT org_realm_move_authority_epoch_check;
ALTER TABLE access.org_realm_move ADD CONSTRAINT org_realm_move_authority_epoch_check CHECK (authority_epoch >= 0);
