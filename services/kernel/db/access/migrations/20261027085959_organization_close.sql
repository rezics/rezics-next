-- migrate:up
-- A close commits only this checkpoint. Member work starts after its barrier.
CREATE TABLE access.organization_close (
  route integer NOT NULL,
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  handle text,
  step integer NOT NULL DEFAULT 0,
  cursor_member uuid,
  cursor_valid tstzrange,
  complete boolean NOT NULL DEFAULT false,
  handle_key text NOT NULL,
  PRIMARY KEY (route, organization_id),
  CHECK (route = get_byte(uuid_send(organization_id), 10) * 256 + get_byte(uuid_send(organization_id), 11))
);
CREATE INDEX organization_member_cleanup ON access.organization_member
  (route, organization_id, member_account_id, valid);

-- migrate:down
-- Forward only: deleted organizations and cleanup checkpoints are durable.
