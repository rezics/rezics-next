-- Admission sealing already has a classified graph outbox event. Inventory
-- restore, rebuild and repair writes have no such event and must fence reuse.
CREATE FUNCTION access.advance_discovery_rating_repair_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NULL; END IF;
    IF TG_OP IN ('INSERT','UPDATE')
        AND current_setting('rezics.discovery_rating_outbox',true)='on' THEN RETURN NULL; END IF;
    UPDATE access.discovery_source_fence SET revision=revision+1 WHERE id;
    RETURN NULL;
END $$;
DO $$ DECLARE source text; BEGIN
    FOREACH source IN ARRAY ARRAY['rating_aggregate_context','rating_aggregate_head'] LOOP
        EXECUTE format('CREATE TRIGGER discovery_source_changed AFTER INSERT OR UPDATE OR DELETE
            ON access.%I FOR EACH ROW EXECUTE FUNCTION access.advance_discovery_rating_repair_fence()',source);
        EXECUTE format('CREATE TRIGGER discovery_source_truncated AFTER TRUNCATE
            ON access.%I FOR EACH STATEMENT EXECUTE FUNCTION access.advance_discovery_rating_repair_fence()',source);
    END LOOP;
END $$;
