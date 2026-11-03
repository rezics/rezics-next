WITH prior AS MATERIALIZED (
  SELECT coverage_complete
  FROM library.entry_state_change
  WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
    AND incarnation_id = :incarnation_id::uuid
  ORDER BY revision DESC
  LIMIT 1
)
INSERT INTO library.entry_state_change
  (route, account_id, subject_id, incarnation_id, prior_revision, revision, before_state,
   before_profile_pin, after_state, after_profile_pin, command_id, command_kind, changed_at, coverage_complete)
SELECT :route::integer, :account_id::uuid, :subject_id::uuid, :incarnation_id::uuid,
       :prior_revision::nullable(integer), :revision::integer, :before_state::nullable(text),
       :before_profile_pin::nullable(jsonb), :after_state::text, :after_profile_pin::nullable(jsonb),
       :command_id::uuid, :command_kind::text, :changed_at::timestamptz,
       CASE WHEN :prior_revision::nullable(integer) IS NULL THEN true
            ELSE COALESCE((SELECT coverage_complete FROM prior), false) END
RETURNING revision;
