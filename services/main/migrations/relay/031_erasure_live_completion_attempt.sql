-- A seal callback runs after the publication fence is released. Its absence
-- evidence may clear the queue only while its own attempt is still current.
ALTER TABLE relay.erasure ADD COLUMN live_completion_attempt bigint NOT NULL DEFAULT 0
  CHECK (live_completion_attempt >= 0);
