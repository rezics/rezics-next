SELECT 1 FROM semantic.context
WHERE route = :route::integer AND context_id = :context_id::uuid AND kind = 'community'
  AND recorded_transaction_id IS NOT NULL AND xmin = pg_current_xact_id()::xid;
