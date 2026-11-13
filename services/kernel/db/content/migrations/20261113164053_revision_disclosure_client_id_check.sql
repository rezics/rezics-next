-- migrate:up
-- Keep the Access durable client identity rule without a POSIX repetition bound above 255.
ALTER TABLE content.revision_disclosure
  DROP CONSTRAINT revision_disclosure_actor_client_id_check;

ALTER TABLE content.revision_disclosure
  ADD CONSTRAINT revision_disclosure_actor_client_id_check
  CHECK (
    octet_length(actor_client_id) BETWEEN 1 AND 1024
    AND actor_client_id COLLATE "C" !~ '[^!-~]'
  );

-- migrate:down
-- Forward only: the former {1,1024} repetition is invalid in PostgreSQL, while dropping the check weakens identity.
DO $$ BEGIN
  RAISE EXCEPTION 'Cannot restore the invalid revision disclosure client ID check or weaken its identity rule';
END $$;
