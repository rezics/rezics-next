-- Stable presentation identity is stored with the intent; labels and target
-- content are resolved from their owners when the recipient reads the inbox.
CREATE TABLE access.notification_display_context (
    item_id uuid PRIMARY KEY REFERENCES access.notification_item(id),
    kind text NOT NULL CHECK (kind IN ('reply', 'submission_decision', 'moderation_outcome',
        'realm_role_change', 'follow', 'claim_correction')),
    actor_agent text CHECK (actor_agent IS NULL OR
        actor_agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
    realm text CHECK (realm IS NULL OR length(realm) BETWEEN 1 AND 512),
    group_key text CHECK (group_key IS NULL OR length(group_key) BETWEEN 1 AND 256)
);
CREATE TRIGGER notification_display_context_immutable BEFORE UPDATE OR DELETE
    ON access.notification_display_context
    FOR EACH ROW EXECUTE FUNCTION access.reject_notification_mutation();
