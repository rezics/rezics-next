-- Email digest candidates are separate from the inbox: disabling the inbox
-- must not disable a person's requested email channel.
CREATE TABLE access.notification_seen (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    source_owner text NOT NULL,
    source_event text NOT NULL,
    topic text NOT NULL,
    PRIMARY KEY (principal_id, source_owner, source_event, topic)
);
INSERT INTO access.notification_seen (principal_id, source_owner, source_event, topic)
    SELECT principal_id, source_owner, source_event, topic FROM access.notification_item WHERE true
    ON CONFLICT DO NOTHING;

CREATE TABLE access.notification_digest_day (
    principal_id uuid NOT NULL REFERENCES access.principal(id),
    day date NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent')),
    lease_until timestamptz,
    PRIMARY KEY (principal_id, day)
);
CREATE INDEX notification_digest_due ON access.notification_digest_day (day, principal_id)
    WHERE state <> 'sent';

CREATE TABLE access.notification_digest_candidate (
    principal_id uuid NOT NULL,
    day date NOT NULL,
    source_owner text NOT NULL,
    source_event text NOT NULL,
    purpose text NOT NULL,
    topic text NOT NULL,
    subject_owner text NOT NULL,
    subject_ref text NOT NULL,
    subject_revision text,
    disclosure_basis text NOT NULL,
    realm text,
    PRIMARY KEY (principal_id, source_owner, source_event, topic),
    FOREIGN KEY (principal_id, day) REFERENCES access.notification_digest_day(principal_id, day)
);
CREATE INDEX notification_digest_candidates_day ON access.notification_digest_candidate
    (principal_id, day, source_event);
