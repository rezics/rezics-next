-- migrate:up
CREATE TABLE library.owner_write_counter (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  PRIMARY KEY (route, account_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);
-- NULL is genuinely unsequenced, never ready zero. No default or legacy backfill.
ALTER TABLE library.entry ADD COLUMN owner_write_seq bigint CHECK (owner_write_seq > 0);
ALTER TABLE library.entry_deleted ADD COLUMN owner_write_seq bigint CHECK (owner_write_seq > 0);
-- Terminal private-data erasure locator: library.owner_write_counter (route, account_id).
-- Absent full-graph participant must erase it after fencing writes at T, with live/archive sequences; no runtime here.
-- migrate:down
-- Forward only: never reset private owner ordering or discard retained sequences.
