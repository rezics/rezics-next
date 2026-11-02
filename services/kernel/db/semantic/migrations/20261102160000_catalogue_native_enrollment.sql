-- migrate:up
-- A native job position and its result commit with the bounded catalogue mutation.
-- Historical allocations remain audit records; new commands require no funding rows.
CREATE TABLE semantic.definition_catalogue_checkpoint (
 route integer NOT NULL CHECK(route=0),
 root_digest text NOT NULL,
 phase text NOT NULL CHECK(phase IN ('step','activation-step')),
 job_id uuid NOT NULL,
 position bigint NOT NULL CHECK(position>=0),
 result bytea NOT NULL CHECK(octet_length(result) BETWEEN 1 AND 65536),
 recorded_transaction_id uuid NOT NULL,
 PRIMARY KEY(route,root_digest,phase,job_id,position),
 FOREIGN KEY(route,root_digest) REFERENCES semantic.definition_catalogue_enrollment(route,root_digest)
);

-- migrate:down
DROP TABLE semantic.definition_catalogue_checkpoint;
