-- Keep one Access delivery ledger so strong scope/principal closure, recovery
-- holds, the 30-second send sweep, and terminal receipt accounting include
-- both native Contribution and Content-owned private body reads.
ALTER TABLE access.search_read_lease
    ADD COLUMN target_kind text NOT NULL DEFAULT 'contribution',
    ADD COLUMN content_variant text,
    ADD COLUMN content_resource text,
    ALTER COLUMN contribution DROP NOT NULL,
    DROP CONSTRAINT search_read_lease_scope;

ALTER TABLE access.search_read_lease
    ADD CONSTRAINT search_read_lease_target CHECK (
      (target_kind = 'contribution' AND contribution IS NOT NULL
        AND content_variant IS NULL AND content_resource IS NULL
        AND scope_id = 'contribution:read:' || contribution)
      OR (target_kind = 'content-variant' AND contribution IS NULL
        AND content_variant ~ '^urn:rezics:variant:[0-9a-f-]{36}$'
        AND content_resource ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'
        AND scope_id = 'work:read:' || content_resource)
    );
