-- Keep the complete installed role vocabulary; catalogue editing adds one value.
ALTER TABLE access.role_revision DROP CONSTRAINT role_revision_permissions_check;
ALTER TABLE access.role_revision ADD CONSTRAINT role_revision_permissions_check CHECK (
    cardinality(permissions) <= 2
    AND permissions <@ ARRAY['work.create', 'work.edit']::text[]
);

-- Work edits pin their exact controller and direct grant or catalogue role just
-- as creation does. Existing creation/group branches retain all their fields.
ALTER TABLE access.admission DROP CONSTRAINT represented_work_admission_proof;
ALTER TABLE access.admission ADD CONSTRAINT represented_work_admission_proof CHECK (
    (represented_representation_id IS NULL
        AND represented_representation_generation IS NULL
        AND represented_grant_id IS NULL AND represented_grant_generation IS NULL
        AND represented_subject_generation IS NULL AND represented_principal_epoch IS NULL
        AND role_binding_id IS NULL)
    OR (authority_path = 'represented-agent'
        AND ((action = 'work.create' AND scope_id = 'work:create:root')
            OR (action = 'work.edit' AND scope_id ~ '^work:edit:https://rezics\.com/id/[0-9a-f-]{36}$'))
        AND represented_representation_id IS NOT NULL
        AND represented_representation_generation IS NOT NULL
        AND represented_subject_generation IS NOT NULL
        AND represented_principal_epoch IS NOT NULL
        AND ((represented_grant_id IS NOT NULL AND represented_grant_generation IS NOT NULL
                AND group_grant_id IS NULL AND role_binding_id IS NULL)
            OR (action = 'work.create' AND represented_grant_id IS NULL AND represented_grant_generation IS NULL
                AND group_grant_id IS NOT NULL AND role_binding_id IS NULL)
            OR (represented_grant_id IS NULL AND represented_grant_generation IS NULL
                AND group_grant_id IS NULL AND role_binding_id IS NOT NULL)))
);
