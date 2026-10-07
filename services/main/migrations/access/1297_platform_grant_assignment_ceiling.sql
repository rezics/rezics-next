-- A direct platform:grant confers access.grant.assign.platform on the recipient
-- agent. The ceiling shares the grant lifetime, so expiry ends both, and
-- revocation clears the ceiling in the same transaction. One grant, one ceiling.
CREATE TABLE access.platform_assignment_ceiling (
  grant_id uuid PRIMARY KEY REFERENCES access.principal_permission_grant(id),
  ceiling_id uuid NOT NULL UNIQUE REFERENCES access.permission_grant(id)
);
CREATE TRIGGER platform_assignment_ceiling_immutable
  BEFORE UPDATE OR DELETE ON access.platform_assignment_ceiling
  FOR EACH ROW EXECUTE FUNCTION access.reject_authority_control_mutation();

CREATE FUNCTION access.bind_platform_assignment_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE grant_row record; ceiling_row record; episode_principal uuid;
BEGIN
  SELECT action, valid_until, issuer_subject, principal_id INTO grant_row
    FROM access.principal_permission_grant WHERE id = NEW.grant_id;
  IF grant_row.action IS DISTINCT FROM 'platform:grant' THEN
    RAISE EXCEPTION 'assignment ceiling follows only platform:grant' USING ERRCODE = '23514';
  END IF;
  SELECT issuer_subject, recipient_subject, scope_id, action, valid_until, assigned_by_principal
    INTO ceiling_row FROM access.permission_grant WHERE id = NEW.ceiling_id;
  IF ceiling_row.action IS DISTINCT FROM 'access.grant.assign.platform'
    OR ceiling_row.scope_id IS DISTINCT FROM 'platform:access'
    OR ceiling_row.valid_until IS DISTINCT FROM grant_row.valid_until
    OR ceiling_row.issuer_subject IS DISTINCT FROM grant_row.issuer_subject THEN
    RAISE EXCEPTION 'assignment ceiling differs from its platform:grant' USING ERRCODE = '23514';
  END IF;
  SELECT assigned_by_principal INTO episode_principal
    FROM access.platform_grant_episode WHERE principal_grant_id = NEW.grant_id;
  IF episode_principal IS NULL
    OR episode_principal IS DISTINCT FROM ceiling_row.assigned_by_principal THEN
    RAISE EXCEPTION 'assignment ceiling is not part of the grant episode' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM access.representation
    WHERE principal_id = grant_row.principal_id AND subject_id = ceiling_row.recipient_subject
      AND action = 'agent.control'
  ) THEN
    RAISE EXCEPTION 'assignment ceiling recipient is not the holder agent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER platform_assignment_ceiling_bind
  BEFORE INSERT ON access.platform_assignment_ceiling
  FOR EACH ROW EXECUTE FUNCTION access.bind_platform_assignment_ceiling();

-- Identity stays fixed. active may fall only after the source grant is inactive,
-- and a cleared ceiling cannot be revived.
CREATE FUNCTION access.keep_platform_assignment_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM access.platform_assignment_ceiling WHERE ceiling_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'active' - 'generation')
      IS DISTINCT FROM (to_jsonb(OLD) - 'active' - 'generation')
    OR (NOT OLD.active AND NEW.active) THEN
    RAISE EXCEPTION 'platform assignment ceiling is bound to its grant' USING ERRCODE = '23514';
  END IF;
  IF OLD.active AND NOT NEW.active AND EXISTS (
    SELECT 1 FROM access.platform_assignment_ceiling c
    JOIN access.principal_permission_grant g ON g.id = c.grant_id
    WHERE c.ceiling_id = OLD.id AND g.active
  ) THEN
    RAISE EXCEPTION 'platform assignment ceiling follows its grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER permission_grant_platform_ceiling_keep
  BEFORE UPDATE ON access.permission_grant
  FOR EACH ROW EXECUTE FUNCTION access.keep_platform_assignment_ceiling();

CREATE FUNCTION access.revoke_platform_assignment_ceiling() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE access.permission_grant g SET active = false
  FROM access.platform_assignment_ceiling c
  WHERE c.grant_id = NEW.id AND g.id = c.ceiling_id AND g.active;
  RETURN NULL;
END $$;
CREATE TRIGGER platform_grant_ceiling_revocation
  AFTER UPDATE OF active ON access.principal_permission_grant
  FOR EACH ROW
  WHEN (OLD.action = 'platform:grant' AND OLD.active AND NOT NEW.active)
  EXECUTE FUNCTION access.revoke_platform_assignment_ceiling();
