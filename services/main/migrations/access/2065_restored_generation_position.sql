-- The original generation identity names its admitted source cut. Recovery maps
-- the same backup payload to the graph's newly allocated epoch without changing
-- that identity or rewinding the original source checkpoint.
ALTER TABLE access.derived_generation_input
    ADD COLUMN recovery_data_epoch text,
    ADD CONSTRAINT derived_generation_recovery_position CHECK (
        recovery_data_epoch IS NULL OR length(recovery_data_epoch) BETWEEN 1 AND 64);

CREATE FUNCTION access.guard_generation_recovery_position() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.recovery_data_epoch IS NOT NULL THEN
        RAISE EXCEPTION 'generation recovery position starts absent' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.recovery_data_epoch IS DISTINCT FROM OLD.recovery_data_epoch THEN
            IF NEW.recovery_data_epoch IS NULL
                OR NOT EXISTS (SELECT 1 FROM access.recovery_fence WHERE id AND NOT open) THEN
                RAISE EXCEPTION 'generation epoch mapping requires held recovery' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER generation_recovery_position_guard BEFORE INSERT OR UPDATE
    ON access.derived_generation_input
    FOR EACH ROW EXECUTE FUNCTION access.guard_generation_recovery_position();
