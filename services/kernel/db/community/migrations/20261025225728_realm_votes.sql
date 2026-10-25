-- migrate:up

-- Reaction kinds are content's REACTION_KINDS. A weight is only +1 or -1.
-- An empty object counts nothing. At most one entry per kind, so at most 7.
CREATE FUNCTION community.realm_votes_allowed(votes jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN votes IS NULL OR jsonb_typeof(votes) <> 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(votes)) > 7 THEN false
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_each(votes) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'])
         OR jsonb_typeof(entry.value) <> 'number'
         OR (entry.value <> '1'::jsonb AND entry.value <> '-1'::jsonb)
    ) THEN false
    ELSE true
  END;
$$;

ALTER TABLE community.realm_revision
  ADD COLUMN votes jsonb NOT NULL DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb
  CONSTRAINT realm_revision_votes_check CHECK (community.realm_votes_allowed(votes));

ALTER TABLE community.realm
  ADD COLUMN votes jsonb NOT NULL DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb
  CONSTRAINT realm_votes_check CHECK (community.realm_votes_allowed(votes));

-- Metadata revisions omit votes, so PostgreSQL fills the column default before this
-- trigger. That default means "keep the predecessor". An explicit other map is kept,
-- which is how a later votes edit can record a different weight without a new statement here.
CREATE FUNCTION community.inherit_realm_votes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT votes INTO NEW.votes
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realm_revision_votes BEFORE INSERT ON community.realm_revision
FOR EACH ROW
WHEN (NEW.predecessor IS NOT NULL AND NEW.votes = '{"upvote": 1, "downvote": -1}'::jsonb)
EXECUTE FUNCTION community.inherit_realm_votes();

-- The head update reads the new revision's votes through this function so the statement
-- stays one row and names its route parameter once. plpgsql is not inlined, so the
-- revision read does not add a second route binding to the head statement.
CREATE FUNCTION community.realm_revision_votes(route integer, realm_id uuid, revision_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  found jsonb;
BEGIN
  SELECT revision.votes INTO found
  FROM community.realm_revision AS revision
  WHERE revision.route = realm_revision_votes.route
    AND revision.realm_id = realm_revision_votes.realm_id
    AND revision.revision_id = realm_revision_votes.revision_id;
  RETURN found;
END;
$$;

-- migrate:down
-- Forward only: Realm vote weights are part of the revision history.
