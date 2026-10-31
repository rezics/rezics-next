-- migrate:up
-- A new request baseline must not invalidate or rewrite earlier physical request evidence.
ALTER TABLE commerce.checkout_creation_attempt
  DROP CONSTRAINT checkout_creation_attempt_api_version_check,
  ADD CONSTRAINT checkout_creation_attempt_api_version_check
    CHECK (api_version IS NULL OR api_version IN ('2026-09-30.endive', '2026-10-28.endive'));

-- migrate:down
-- Keep both dates: narrowing the constraint could invalidate immutable requests captured since adoption.
