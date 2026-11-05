WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :subject_id::uuid AS subject_id
), victims AS MATERIALIZED (
  SELECT history.incarnation_id, history.revision
  FROM library.entry_state_change AS history, input AS arg
  WHERE history.route = arg.route AND history.account_id = arg.account_id AND history.subject_id = arg.subject_id
  ORDER BY history.changed_at DESC, history.incarnation_id DESC, history.revision DESC
  OFFSET 64
)
DELETE FROM library.entry_state_change AS history
USING victims, input AS arg
WHERE history.route = arg.route AND history.account_id = arg.account_id
  AND history.subject_id = arg.subject_id
  AND history.incarnation_id = victims.incarnation_id AND history.revision = victims.revision
RETURNING history.incarnation_id AS "incarnationId";
