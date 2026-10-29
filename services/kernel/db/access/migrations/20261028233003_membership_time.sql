-- migrate:up
-- Owner guards must not observe an older validity time than a membership write
-- that already committed under the organization's account lock.
ALTER TABLE access.account
  ADD COLUMN membership_time timestamptz CHECK (isfinite(membership_time));

-- migrate:down
-- Forward only: owner protection depends on the committed membership time.
