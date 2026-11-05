-- migrate:up
CREATE OR REPLACE FUNCTION library.advance_progress_discovery_generation_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO library.progress_discovery_generation (route, account_id, generation)
  SELECT owners.route, owners.account_id, 1
  FROM (
    SELECT previous_row.route, previous_row.account_id
    FROM old_rows AS previous_row JOIN new_rows AS next_row USING (route, session_id)
    WHERE (previous_row.account_id, previous_row.subject_id, previous_row.state, previous_row.mode, previous_row.started_at, previous_row.library_profile_pin)
      IS DISTINCT FROM
      (next_row.account_id, next_row.subject_id, next_row.state, next_row.mode, next_row.started_at, next_row.library_profile_pin)
    UNION
    SELECT next_row.route, next_row.account_id
    FROM old_rows AS previous_row JOIN new_rows AS next_row USING (route, session_id)
    WHERE (previous_row.account_id, previous_row.subject_id, previous_row.state, previous_row.mode, previous_row.started_at, previous_row.library_profile_pin)
      IS DISTINCT FROM
      (next_row.account_id, next_row.subject_id, next_row.state, next_row.mode, next_row.started_at, next_row.library_profile_pin)
  ) AS owners
  GROUP BY owners.route, owners.account_id ORDER BY owners.route, owners.account_id
  ON CONFLICT (route, account_id) DO UPDATE
    SET generation = library.progress_discovery_generation.generation + 1;
  RETURN NULL;
END;
$$;

-- migrate:down
-- Forward only: restoring the ambiguous old/new aliases would break progress_session UPDATE.
