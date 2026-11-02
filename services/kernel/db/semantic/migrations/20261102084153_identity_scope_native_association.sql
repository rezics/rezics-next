-- migrate:up
-- No backfill: old registration metadata cannot prove a native transaction.
CREATE TABLE semantic.identity_scope_native_association (
    partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
    source_key text NOT NULL CHECK (octet_length(source_key) BETWEEN 1 AND 256),
    scope_id text NOT NULL CHECK (octet_length(scope_id) BETWEEN 1 AND 256),
    registration uuid NOT NULL,
    capture_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    phase text NOT NULL CHECK (phase IN ('registration','capture','enrollment','ready','progress','finish')),
    scan_complete boolean NOT NULL,
    job_id uuid,
    job_epoch bigint CHECK (job_epoch > 0),
    attempt jsonb CHECK (octet_length(attempt::text) <= 1024),
    completion_version bigint CHECK (completion_version > 0),
    CHECK ((job_id IS NULL) = (job_epoch IS NULL)),
    CHECK (phase <> 'finish' OR (job_id IS NOT NULL AND attempt IS NOT NULL AND completion_version IS NOT NULL)),
    source jsonb NOT NULL CHECK (octet_length(source::text) <= 4096),
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL CHECK (epoch > 0),
    position bigint NOT NULL CHECK (position > 0),
    purpose text NOT NULL CHECK (purpose IN ('identity-scope-registration','identity-scope-enrollment','identity-scope-finish')),
    PRIMARY KEY (partition_no,source_key,scope_id,registration,capture_id,revision,phase),
    FOREIGN KEY (partition_no,transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no,transaction_id)
);

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Identity scope native associations are forward only'; END $$;
