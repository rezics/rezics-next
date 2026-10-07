-- A Concept feed binds only its selected interpretations, not global coverage.
CREATE TABLE access.template_discovery_basis (
    generation uuid NOT NULL, term text NOT NULL, revision bigint NOT NULL DEFAULT 0,
    PRIMARY KEY(generation,term)
);
CREATE FUNCTION access.advance_template_discovery_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row_data access.discovery_entry;
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN row_data=OLD; ELSE row_data=NEW; END IF;
    IF row_data.work_type<>'' OR row_data.term='' THEN RETURN NULL; END IF;
    INSERT INTO access.template_discovery_basis(generation,term,revision)
    VALUES(row_data.generation_id,row_data.term,1)
    ON CONFLICT(generation,term) DO UPDATE SET revision=access.template_discovery_basis.revision+1;
    RETURN NULL;
END $$;
CREATE TRIGGER template_discovery_membership AFTER INSERT OR UPDATE OR DELETE ON access.discovery_entry
    FOR EACH ROW EXECUTE FUNCTION access.advance_template_discovery_basis();
