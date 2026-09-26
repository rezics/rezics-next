-- A role binding pins one immutable revision and recipient. The generation
-- trigger invalidates saved proofs on revoke, but must not permit a direct SQL
-- retarget to widen an already populated binding outside the Access API.
CREATE FUNCTION access.keep_role_binding_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
        OR NEW.family_id IS DISTINCT FROM OLD.family_id
        OR NEW.role_revision IS DISTINCT FROM OLD.role_revision
        OR NEW.issuer_subject IS DISTINCT FROM OLD.issuer_subject
        OR NEW.recipient_subject IS DISTINCT FROM OLD.recipient_subject
        OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
        OR NEW.assigned_by_principal IS DISTINCT FROM OLD.assigned_by_principal
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
        OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
        OR NEW.membership_generation IS DISTINCT FROM OLD.membership_generation
        OR (NOT OLD.active AND NEW.active) THEN
        RAISE EXCEPTION 'role binding target is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER role_binding_target_immutable BEFORE UPDATE
    ON access.role_binding FOR EACH ROW
    EXECUTE FUNCTION access.keep_role_binding_target();
