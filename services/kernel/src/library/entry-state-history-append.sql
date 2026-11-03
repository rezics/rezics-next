WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id,
         :incarnation_id::uuid AS incarnation_id, :prior_revision::nullable(integer) AS prior_revision,
         :revision::integer AS revision, :before_state::nullable(text) AS before_state,
         :before_profile_pin::nullable(jsonb) AS before_profile_pin, :after_state::text AS after_state,
         :after_profile_pin::nullable(jsonb) AS after_profile_pin, :command_id::uuid AS command_id,
         :command_kind::text AS command_kind, :changed_at::timestamptz AS changed_at
), prior AS MATERIALIZED (
  SELECT history.coverage_complete
  FROM library.entry_state_change AS history, input AS arg
  WHERE history.route = arg.route AND history.account_id = arg.account_id AND history.subject_id = arg.subject_id
    AND history.incarnation_id = arg.incarnation_id
  ORDER BY history.revision DESC
  LIMIT 1
)
INSERT INTO library.entry_state_change
  (route, account_id, subject_id, incarnation_id, prior_revision, revision, before_state,
   before_profile_pin, after_state, after_profile_pin, command_id, command_kind, changed_at, coverage_complete)
SELECT arg.route, arg.account_id, arg.subject_id, arg.incarnation_id,
       arg.prior_revision, arg.revision, arg.before_state,
       arg.before_profile_pin, arg.after_state, arg.after_profile_pin,
       arg.command_id, arg.command_kind, arg.changed_at,
       CASE WHEN arg.prior_revision IS NULL THEN true
            ELSE COALESCE((SELECT coverage_complete FROM prior), false) END
FROM input AS arg
RETURNING revision;
