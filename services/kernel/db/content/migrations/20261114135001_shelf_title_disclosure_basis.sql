-- migrate:up
-- Source-fence changes retire complete Content disclosure observations.
CREATE TRIGGER source_fence_publication_authority
AFTER INSERT OR DELETE OR UPDATE ON content.source_fences
FOR EACH ROW EXECUTE FUNCTION core.bump_publication_authority_route_row();

-- migrate:down
DO $$
BEGIN
  RAISE EXCEPTION 'Content disclosure invalidator coverage is forward-only' USING ERRCODE='23514';
END;
$$;
