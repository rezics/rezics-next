-- Raw dependency registration, never original admission or current evidence.
-- The caller supplies the already resolved original episode as data. Its private
-- authority association must be independently resolved before any promotion.
INSERT INTO semantic.kind_type_evidence_body (
  route, owner_account_id, collection_id, preparation_id, evidence_id,
  binding, body, progress, producer_transaction
) VALUES (
  :route::integer, :owner_account_id::uuid, :collection_id::uuid,
  :preparation_id::uuid, :evidence_id::uuid, :binding::jsonb, :body::jsonb,
  :progress::jsonb, pg_current_xact_id()::text
)
ON CONFLICT (route, owner_account_id, collection_id, preparation_id, evidence_id)
DO NOTHING
RETURNING evidence_id::text;
