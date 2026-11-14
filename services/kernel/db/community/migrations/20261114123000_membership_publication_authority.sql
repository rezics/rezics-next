-- migrate:up
-- Realm membership controls current protected Content and Library disclosure.
CREATE TRIGGER realm_member_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON community.realm_member
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Community membership publication invalidator coverage is forward-only' USING ERRCODE='23514';
END;
$$;
