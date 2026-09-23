-- Private copy of Access Account-deletion intents retained outside Access backups.
CREATE TABLE relay.account_deletion_intent (
    outbox_id uuid PRIMARY KEY,
    principal_id uuid NOT NULL UNIQUE,
    authority_epoch numeric NOT NULL CHECK (authority_epoch >= 1 AND authority_epoch = trunc(authority_epoch)),
    delivered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
