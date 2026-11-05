UPDATE commerce.subject_offer_bootstrap
SET frontier = :frontier::text, version = version + 1, ready = ready OR :ready::boolean
WHERE partition_no = 0 AND version = :version::bigint AND frontier = :previous::text
RETURNING version::text AS version;
