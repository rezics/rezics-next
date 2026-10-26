INSERT INTO semantic.inbound_link (
  route, subject_id, property, source_subject_id, statement_id, source_revision, source_security_revision, present,
  recorded_transaction_id
)
SELECT :route::integer, change.subject_id, change.property, change.source_subject_id, change.statement_id,
       change.source_revision, change.source_security_revision, change.present, :transaction_id::uuid
FROM jsonb_to_recordset(:changes::jsonb) AS change(
  subject_id uuid,
  property text,
  source_subject_id uuid,
  statement_id uuid,
  source_revision integer,
  source_security_revision bigint,
  present boolean
)
ON CONFLICT (route, subject_id, property, source_subject_id, statement_id)
DO UPDATE SET source_revision = EXCLUDED.source_revision,
              source_security_revision = EXCLUDED.source_security_revision,
              present = EXCLUDED.present,
              recorded_transaction_id = EXCLUDED.recorded_transaction_id
WHERE semantic.inbound_link.source_revision < EXCLUDED.source_revision
   OR (semantic.inbound_link.source_revision = EXCLUDED.source_revision
       AND semantic.inbound_link.source_security_revision < EXCLUDED.source_security_revision);
