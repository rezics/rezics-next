WITH victims AS MATERIALIZED (
  SELECT incarnation_id, revision
  FROM library.entry_state_change
  WHERE route = :route::integer AND account_id = :account_id::uuid AND subject_id = :subject_id::uuid
  ORDER BY changed_at DESC, incarnation_id DESC, revision DESC
  OFFSET 64
)
DELETE FROM library.entry_state_change AS history
USING victims
WHERE history.route = :route::integer AND history.account_id = :account_id::uuid
  AND history.subject_id = :subject_id::uuid
  AND history.incarnation_id = victims.incarnation_id AND history.revision = victims.revision
RETURNING history.incarnation_id AS "incarnationId";
