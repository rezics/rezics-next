-- Preserve the complete installed vocabulary from 870; review adds one value.
ALTER TABLE access.role_revision DROP CONSTRAINT role_revision_permissions_check;
ALTER TABLE access.role_revision ADD CONSTRAINT role_revision_permissions_check CHECK (
    cardinality(permissions) <= 3
    AND permissions <@ ARRAY['work.create', 'work.edit', 'work.review']::text[]
);
