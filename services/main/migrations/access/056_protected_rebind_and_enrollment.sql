-- An approved rewrite of a protected role family rebinds every current holder
-- to the new revision in its activation transaction, so those bindings share
-- one activation. Binding a new holder still needs its own role-binding change.
DROP INDEX access.role_binding_protected_change;
CREATE INDEX role_binding_protected_change ON access.role_binding (protected_change_id)
    WHERE protected_change_id IS NOT NULL;
CREATE OR REPLACE FUNCTION access.require_protected_change(change_id uuid, change_kind text,
    change_object uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM access.protected_change_activation
        WHERE proposal_id = change_id AND target_object = change_object
            AND (kind = change_kind
                OR (change_kind = 'role-binding' AND kind = 'role-revision'
                    AND activation_txid = txid_current()));
    IF NOT FOUND THEN
        RAISE EXCEPTION 'protected authority change requires its approved activation'
            USING ERRCODE = '23514';
    END IF;
END $$;

-- A workload principal enrolls itself for one owner and action set; the
-- owner's administrator names only this 15-minute handle when installing it,
-- never the workload's Account or Access principal identity.
CREATE TABLE access.automation_enrollment (
    id uuid PRIMARY KEY,
    workload_principal uuid NOT NULL REFERENCES access.principal(id),
    owner_subject text NOT NULL REFERENCES access.authority_subject(id),
    actions text[] NOT NULL CHECK (cardinality(actions) BETWEEN 1 AND 32
        AND array_position(actions, NULL) IS NULL),
    valid_until timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
    CHECK (valid_until > created_at)
);
CREATE INDEX automation_enrollment_workload_fk ON access.automation_enrollment
    (workload_principal);
CREATE INDEX automation_enrollment_owner_fk ON access.automation_enrollment (owner_subject);
CREATE TRIGGER automation_enrollment_immutable BEFORE UPDATE OR DELETE
    ON access.automation_enrollment FOR EACH ROW
    EXECUTE FUNCTION access.reject_authority_control_mutation();
ALTER TABLE access.automation_installation
    ADD COLUMN enrollment_id uuid UNIQUE REFERENCES access.automation_enrollment(id);
