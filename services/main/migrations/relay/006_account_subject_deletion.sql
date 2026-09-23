-- Independent Account erasure intent, including users without an Access principal.
CREATE TABLE relay.account_subject_deletion (
    issuer text NOT NULL CHECK (issuer <> ''),
    account_subject text NOT NULL CHECK (account_subject <> ''),
    retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (issuer, account_subject)
);
