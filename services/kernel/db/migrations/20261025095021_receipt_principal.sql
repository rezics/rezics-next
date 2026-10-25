-- migrate:up
ALTER TABLE core.receipt RENAME COLUMN actor_account_id TO principal_id;
ALTER TABLE core.receipt
  ADD COLUMN principal_kind text NOT NULL DEFAULT 'account',
  ADD COLUMN actor_account_id uuid GENERATED ALWAYS AS
    (CASE WHEN principal_kind = 'account' THEN principal_id END) STORED;
ALTER TABLE core.receipt ALTER COLUMN principal_kind DROP DEFAULT;
ALTER TABLE core.receipt DROP CONSTRAINT receipt_pkey;
ALTER TABLE core.receipt
  ADD PRIMARY KEY (partition_no, principal_kind, principal_id, command_kind, idempotency_key),
  ADD CONSTRAINT receipt_principal_check CHECK (
    (principal_kind = 'account' AND principal_id <> '00000000-0000-0000-0000-000000000000') OR
    (principal_kind = 'anonymous' AND principal_id = '00000000-0000-0000-0000-000000000000')
  ),
  ADD CONSTRAINT receipt_anonymous_key_check CHECK (
    principal_kind <> 'anonymous' OR
    idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

ALTER TABLE editorial.write_basis RENAME COLUMN actor_account_id TO principal_id;
ALTER TABLE editorial.write_basis
  ADD COLUMN principal_kind text NOT NULL DEFAULT 'account',
  ADD COLUMN actor_account_id uuid GENERATED ALWAYS AS
    (CASE WHEN principal_kind = 'account' THEN principal_id END) STORED;
ALTER TABLE editorial.write_basis ALTER COLUMN principal_kind DROP DEFAULT;
ALTER TABLE editorial.write_basis ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE editorial.write_basis
  ADD CONSTRAINT write_basis_principal_check CHECK (
    (principal_kind = 'account' AND principal_id <> '00000000-0000-0000-0000-000000000000' AND client_id IS NOT NULL) OR
    (principal_kind = 'anonymous' AND principal_id = '00000000-0000-0000-0000-000000000000'
      AND client_id IS NULL AND requested_by IS NULL)
  );

-- migrate:down
-- Forward-only: anonymous receipts cannot be represented by the former account key.
