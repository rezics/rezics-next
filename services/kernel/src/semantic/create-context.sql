INSERT INTO semantic.context
  (route, context_id, kind, labels, settings_id, settings_release, defaults, recorded_transaction_id)
VALUES (
  :route::integer,
  :context_id::uuid,
  'community',
  :labels::jsonb,
  :settings_id::nullable(text),
  :settings_release::nullable(text),
  :defaults::jsonb,
  :transaction_id::uuid
);
