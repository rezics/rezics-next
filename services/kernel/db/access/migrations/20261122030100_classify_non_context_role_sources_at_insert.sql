-- migrate:up
CREATE FUNCTION access.classify_non_context_role_provenance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.delivery := 'not-applicable';
  RETURN NEW;
END;
$$;

-- The deferred delivery trigger still locks the active home and validates the source.
-- Only Context roles need a receiving decision.
CREATE TRIGGER resource_role_provenance_non_context BEFORE INSERT ON access.resource_role_provenance
FOR EACH ROW WHEN (NEW.resource_type <> 'semantic.context' AND NEW.delivery = 'pending')
EXECUTE FUNCTION access.classify_non_context_role_provenance();

-- migrate:down
DROP TRIGGER resource_role_provenance_non_context ON access.resource_role_provenance;
DROP FUNCTION access.classify_non_context_role_provenance();
