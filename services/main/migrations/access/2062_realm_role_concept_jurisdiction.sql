-- A role's exact Concept jurisdiction survives edits and assignments.
-- NULL preserves existing Realm-wide roles without rewriting their authority.
ALTER TABLE access.realm_admin_role ADD COLUMN target_concept text
    CHECK (target_concept IS NULL OR target_concept ~
        '^https://rezics[.]com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
