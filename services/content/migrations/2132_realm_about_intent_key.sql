-- Composite commands bind an opaque intent key to the verified principal,
-- independent of which Person the payload names. Legacy actor keys remain valid.
CREATE INDEX realm_about_post_intent_key ON content.realm_about_post_operation(intent_key);
