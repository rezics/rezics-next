-- migrate:up
-- Keep the Access durable client identity rule without a POSIX repetition bound above 255.
ALTER TABLE content.revision_disclosure
  DROP CONSTRAINT revision_disclosure_actor_client_id_check;

-- Access issuer accounts can belong to a different route from the source Content row.
ALTER TABLE content.revision_disclosure
  DROP CONSTRAINT revision_disclosure_check6;

ALTER TABLE content.revision_disclosure
  ADD CONSTRAINT revision_disclosure_actor_client_id_check
  CHECK (
    octet_length(actor_client_id) BETWEEN 1 AND 1024
    AND actor_client_id COLLATE "C" !~ '[^!-~]'
  );

-- migrate:down
-- Forward only: the former {1,1024} bound is invalid, and restoring issuer route equality would reject valid actors.
DO $$ BEGIN
  RAISE EXCEPTION 'Cannot restore the invalid client ID bound or reject cross-route Access issuers';
END $$;
