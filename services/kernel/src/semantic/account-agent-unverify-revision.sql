INSERT INTO semantic.revision (
  route, subject_id, revision, kind, release, recorded_transaction_id,
  verification_receipt_id, revocation_receipt_id, revoked_survivor_id
)
VALUES (
  :route::integer, :subject_id::uuid, :revision::integer, 'merge', :release::text,
  :transaction_id::uuid, :verification_receipt_id::text, :revocation_receipt_id::text,
  :revoked_survivor_id::uuid
);
