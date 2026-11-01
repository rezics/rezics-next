-- migrate:up

-- The existing mixed writer retains the original independent Account input with
-- its immutable action array. Legacy Subject receipts intentionally have none.
ALTER TABLE search.identity_writer
  ADD COLUMN repair_account text CHECK (octet_length(repair_account) <= 65536);

-- migrate:down
ALTER TABLE search.identity_writer DROP COLUMN repair_account;
