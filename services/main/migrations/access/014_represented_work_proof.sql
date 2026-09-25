-- A represented work.create admission pins the exact mandate and grant path.
-- Older in-flight admissions have no selected proof and fail closed at claim.
ALTER TABLE access.admission ADD COLUMN represented_representation_id uuid
    REFERENCES access.representation(id);
ALTER TABLE access.admission ADD COLUMN represented_representation_generation bigint;
ALTER TABLE access.admission ADD COLUMN represented_grant_id uuid
    REFERENCES access.permission_grant(id);
ALTER TABLE access.admission ADD COLUMN represented_grant_generation bigint;
ALTER TABLE access.admission ADD COLUMN represented_subject_generation bigint;
ALTER TABLE access.admission ADD COLUMN represented_principal_epoch bigint;
ALTER TABLE access.admission ADD CONSTRAINT represented_work_admission_proof CHECK (
    (represented_representation_id IS NULL
        AND represented_representation_generation IS NULL
        AND represented_grant_id IS NULL AND represented_grant_generation IS NULL
        AND represented_subject_generation IS NULL AND represented_principal_epoch IS NULL)
    OR (authority_path = 'represented-agent' AND action = 'work.create'
        AND scope_id = 'work:create:root'
        AND represented_representation_id IS NOT NULL
        AND represented_representation_generation IS NOT NULL
        AND represented_subject_generation IS NOT NULL
        AND represented_principal_epoch IS NOT NULL
        AND ((represented_grant_id IS NOT NULL AND represented_grant_generation IS NOT NULL
                AND group_grant_id IS NULL)
            OR (represented_grant_id IS NULL AND represented_grant_generation IS NULL
                AND group_grant_id IS NOT NULL)))
);

-- The Access owner can update mandate/grant rows directly today. Every update,
-- including revoke and restore, advances the dependency generation.
CREATE FUNCTION access.advance_authority_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.generation := GREATEST(NEW.generation, OLD.generation + 1);
    RETURN NEW;
END $$;
CREATE TRIGGER representation_generation_advance BEFORE UPDATE
    ON access.representation FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER permission_grant_generation_advance BEFORE UPDATE
    ON access.permission_grant FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();
CREATE TRIGGER authority_subject_generation_advance BEFORE UPDATE
    ON access.authority_subject FOR EACH ROW
    EXECUTE FUNCTION access.advance_authority_generation();

CREATE FUNCTION access.advance_principal_enforcement_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.enforcement_epoch := GREATEST(NEW.enforcement_epoch, OLD.enforcement_epoch + 1);
    RETURN NEW;
END $$;
CREATE TRIGGER principal_enforcement_epoch_advance BEFORE UPDATE
    ON access.principal FOR EACH ROW
    EXECUTE FUNCTION access.advance_principal_enforcement_epoch();
