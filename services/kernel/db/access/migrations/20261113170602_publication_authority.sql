-- migrate:up
-- Access state and earliest erasure admission close a Book proof in their own
-- physical transaction. The route-led home is independent of log position.
CREATE TRIGGER account_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF state,minimum_authn_epoch,authn_fenced ON access.account
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER erasure_publication_authority
AFTER INSERT OR DELETE OR UPDATE OF version,at,completed_at ON access.erasure
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER resource_grant_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON access.resource_grant
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER resource_denial_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON access.resource_denial
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER resource_role_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON access.resource_role_grant
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER resource_initialization_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON access.resource_initialization
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

CREATE TRIGGER principal_assignment_publication_authority
AFTER INSERT OR UPDATE OR DELETE ON access.principal_assignment
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Access publication invalidator coverage is forward-only' USING ERRCODE='23514';
END;
$$;
