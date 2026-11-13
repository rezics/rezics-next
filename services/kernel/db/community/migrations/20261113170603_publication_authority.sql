-- migrate:up
-- Current Realm/Space ancestry, its current ban list, and placement must move
-- the owning logical home's epoch with each eligibility-closing mutation.
CREATE TRIGGER space_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF state,head_revision_id ON community.space
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER space_revision_publication_authority
AFTER INSERT OR DELETE OR UPDATE ON community.space_revision
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER realm_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF state,visibility,head_revision_id,space_id ON community.realm
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER realm_revision_publication_authority
AFTER INSERT OR DELETE OR UPDATE ON community.realm_revision
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER realm_ban_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON community.realm_ban
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Community publication invalidator coverage is forward-only' USING ERRCODE='23514';
END;
$$;
