-- An Agent avatar admission pins the exact live controller, independently of
-- the member's own Person provision and Work author proof.
ALTER TABLE access.baseline_admission
    ADD COLUMN avatar_control_id uuid REFERENCES access.representation(id),
    ADD COLUMN avatar_control_generation bigint CHECK (avatar_control_generation >= 0),
    ADD CONSTRAINT baseline_avatar_control_pair CHECK
      ((avatar_control_id IS NULL) = (avatar_control_generation IS NULL));
CREATE INDEX baseline_admission_avatar_control ON access.baseline_admission (avatar_control_id)
    WHERE avatar_control_id IS NOT NULL;
