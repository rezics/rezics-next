WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id,
         :incarnation_id::uuid AS incarnation_id, :after_revision::nullable(integer) AS after_revision,
         :page_limit::integer AS page_limit
)
SELECT history.revision, history.prior_revision AS "priorRevision", history.before_state AS "beforeState",
       history.after_state AS "afterState", history.command_id AS "commandId", history.command_kind AS "commandKind",
       history.changed_at::text AS "changedAt", history.coverage_complete AS "coverageComplete"
FROM library.entry_state_change AS history, input AS arg
WHERE history.route = arg.route AND history.account_id = arg.account_id AND history.subject_id = arg.subject_id
  AND history.incarnation_id = arg.incarnation_id
  AND (arg.after_revision IS NULL OR history.revision < arg.after_revision)
ORDER BY history.revision DESC
LIMIT (SELECT arg.page_limit FROM input AS arg);
