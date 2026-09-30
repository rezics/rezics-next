-- Widen the scoped Work editor branch from the complete installed 870 CHECK.
-- Preserve the empty-proof, Work creation, group-grant and catalogue-role branches.
ALTER TABLE access.admission DROP CONSTRAINT represented_work_admission_proof;
ALTER TABLE access.admission ADD CONSTRAINT represented_work_admission_proof CHECK (
    (represented_representation_id IS NULL
        AND represented_representation_generation IS NULL
        AND represented_grant_id IS NULL AND represented_grant_generation IS NULL
        AND represented_subject_generation IS NULL AND represented_principal_epoch IS NULL
        AND role_binding_id IS NULL)
    OR (authority_path = 'represented-agent'
        AND ((action = 'work.create' AND scope_id = 'work:create:root')
            OR (action IN ('work.edit', 'work.derive', 'relation.change')
                AND scope_id ~ '^work:edit:https://rezics\.com/id/[0-9a-f-]{36}$'))
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
