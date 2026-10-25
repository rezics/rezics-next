-- migrate:up

-- A scheme is a routed Semantic subject, independently of the Realm's route.
ALTER TABLE community.realm ADD COLUMN board_scheme_id uuid
  CHECK (board_scheme_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE community.realm_revision ADD COLUMN board_scheme_id uuid
  CHECK (board_scheme_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

-- Metadata-only commands omit the scheme. Preserve it in their appended revision.
-- Initial revisions remain null; explicit scheme changes supply their new value.
CREATE FUNCTION community.inherit_realm_board_scheme() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT board_scheme_id INTO NEW.board_scheme_id
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_revision_board_scheme BEFORE INSERT ON community.realm_revision
FOR EACH ROW WHEN (NEW.board_scheme_id IS NULL AND NEW.predecessor IS NOT NULL)
EXECUTE FUNCTION community.inherit_realm_board_scheme();

-- migrate:down
-- Forward only: preserve the Realm's scheme and revision history.
