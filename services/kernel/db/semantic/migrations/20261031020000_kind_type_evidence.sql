-- migrate:up
-- Native Type dependency keys, including an observed missing subject/redirect.
-- This is a per-key Semantic writer fence, not an audience or global epoch.
CREATE TABLE semantic.kind_type_anchor_fence (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

CREATE FUNCTION semantic.fence_kind_type_anchor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    INSERT INTO semantic.kind_type_anchor_fence(route, subject_id, version)
      VALUES (OLD.route, OLD.subject_id, 1)
      ON CONFLICT (route, subject_id) DO UPDATE
      SET version = semantic.kind_type_anchor_fence.version + 1;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND
      (NEW.route, NEW.subject_id) IS DISTINCT FROM (OLD.route, OLD.subject_id)) THEN
    INSERT INTO semantic.kind_type_anchor_fence(route, subject_id, version)
      VALUES (NEW.route, NEW.subject_id, 1)
      ON CONFLICT (route, subject_id) DO UPDATE
      SET version = semantic.kind_type_anchor_fence.version + 1;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- Enrollment locks the exact missing key before observation. Each writer takes
-- that same row lock BEFORE visibility; local adoption retains it until commit.
-- These triggers do not cover foreign Accounts permission/time dependencies.
CREATE TRIGGER kind_type_subject_fence
  BEFORE INSERT OR UPDATE OR DELETE ON semantic.subject
  FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();
CREATE TRIGGER kind_type_revision_fence
  BEFORE INSERT OR UPDATE OR DELETE ON semantic.revision
  FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();
CREATE TRIGGER kind_type_redirect_fence
  BEFORE INSERT OR UPDATE OR DELETE ON semantic.redirect
  FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();
CREATE TRIGGER kind_type_agent_link_fence
  BEFORE INSERT OR UPDATE OR DELETE ON semantic.account_agent_subject
  FOR EACH ROW EXECUTE FUNCTION semantic.fence_kind_type_anchor();

-- migrate:down
DROP TRIGGER kind_type_agent_link_fence ON semantic.account_agent_subject;
DROP TRIGGER kind_type_redirect_fence ON semantic.redirect;
DROP TRIGGER kind_type_revision_fence ON semantic.revision;
DROP TRIGGER kind_type_subject_fence ON semantic.subject;
DROP FUNCTION semantic.fence_kind_type_anchor();
DROP TABLE semantic.kind_type_anchor_fence;
