-- A recorded decision can precede its effective fence. Final disclosure reads
-- must also observe confirmation, release and recovered partial effects.
CREATE FUNCTION access.record_governance_disclosure_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM access.record_site_moderation_change();
    RETURN NULL;
END $$;

CREATE TRIGGER governance_disclosure_change
    AFTER INSERT OR UPDATE ON access.governance_enforcement
    FOR EACH ROW EXECUTE FUNCTION access.record_governance_disclosure_change();
