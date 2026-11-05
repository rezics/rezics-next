INSERT INTO semantic.fact (
  route, subject_id, slot_id, log_seq, operation, kind, language, property, statement_id, body,
  recorded_transaction_id, release, relation
)
SELECT :route::integer, :subject_id::uuid, fact.slot_id, fact.log_seq, fact.operation, fact.kind, fact.language,
       fact.property, fact.statement_id, fact.body, :transaction_id::uuid, fact.release, COALESCE(fact.relation, false)
FROM jsonb_to_recordset(:facts::jsonb) AS fact(
  slot_id uuid,
  log_seq integer,
  operation text,
  kind text,
  language text,
  property text,
  statement_id uuid,
  body jsonb,
  release text,
  relation boolean
);
