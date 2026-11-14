-- migrate:up
-- Organization roles contribute to current subject:read decisions.
CREATE TRIGGER organization_member_publication_authority
AFTER INSERT OR DELETE OR UPDATE ON access.organization_member
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Access disclosure invalidator coverage is forward-only' USING ERRCODE='23514';
END;
$$;
