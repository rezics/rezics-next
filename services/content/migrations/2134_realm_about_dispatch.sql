-- Bind graph dispatch to the existing Access admission and the server-selected
-- Zone cut before sending it. Preparation, graph commit and settlement remain
-- durable in their existing owners, rather than copied progress flags here.
ALTER TABLE content.realm_about_post_operation
    ADD COLUMN placement_admission_id text UNIQUE,
    ADD COLUMN dispatch_zone text,
    ADD COLUMN dispatch_zone_revision text,
    ADD COLUMN dispatch_route_revision text,
    ADD CONSTRAINT realm_about_dispatch_complete CHECK (
        (placement_admission_id IS NULL AND dispatch_zone IS NULL
            AND dispatch_zone_revision IS NULL AND dispatch_route_revision IS NULL)
        OR (placement_admission_id IS NOT NULL AND dispatch_zone IS NOT NULL
            AND dispatch_zone_revision IS NOT NULL AND dispatch_route_revision IS NOT NULL)
    );

CREATE FUNCTION content.guard_realm_about_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.placement_admission_id IS NOT NULL AND
        (NEW.placement_admission_id, NEW.dispatch_zone, NEW.dispatch_zone_revision, NEW.dispatch_route_revision)
        IS DISTINCT FROM
        (OLD.placement_admission_id, OLD.dispatch_zone, OLD.dispatch_zone_revision, OLD.dispatch_route_revision)
    THEN RAISE EXCEPTION 'discussion dispatch selection is immutable' USING ERRCODE = '23514'; END IF;
    IF NEW.placement_admission_id IS NOT NULL AND NEW.phase NOT IN ('identified', 'posted')
    THEN RAISE EXCEPTION 'discussion identity must precede dispatch' USING ERRCODE = '23514'; END IF;
    IF NEW.phase = 'posted' AND NEW.placement_admission_id IS NOT NULL
        AND NEW.placement_operation_id IS DISTINCT FROM NEW.placement_admission_id
    THEN RAISE EXCEPTION 'discussion placement differs from admission' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER realm_about_dispatch_guard BEFORE UPDATE ON content.realm_about_post_operation
    FOR EACH ROW EXECUTE FUNCTION content.guard_realm_about_dispatch();
