WITH input AS MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :deletion_id::uuid AS deletion_id,
         :expected_original_deadline::timestamptz AS expected_deadline, :time::timestamptz AS time
), removed AS (
  DELETE FROM library.entry_deleted AS archived USING input
  WHERE archived.route = input.route AND archived.account_id = input.account_id
    AND archived.deletion_id = input.deletion_id AND archived.restore_until = input.expected_deadline
    AND archived.restore_until <= input.time
  RETURNING archived.route, archived.account_id, archived.subject_id, archived.incarnation_id
), history AS (
  DELETE FROM library.entry_state_change AS changes USING removed
  WHERE changes.route = removed.route AND changes.account_id = removed.account_id
    AND changes.subject_id = removed.subject_id AND changes.incarnation_id = removed.incarnation_id
  RETURNING changes.revision
)
SELECT EXISTS (SELECT 1 FROM removed) AS deleted;
