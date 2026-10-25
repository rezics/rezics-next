-- migrate:up
-- Traverse the overlapping authority once. Reopening a one-row cursor for each
-- change repeats the temporal tree descent, including an extra empty probe.
CREATE OR REPLACE FUNCTION access.close_membership_authority(
  p_route integer, p_organization_id uuid, p_member_id uuid,
  p_at timestamptz, p_transaction_id uuid
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  target record;
  changed integer := 0;
  overlapping CURSOR FOR
    SELECT m.valid
    FROM access.organization_member m
    WHERE m.route = p_route AND m.organization_id = p_organization_id
      AND m.member_account_id = p_member_id
      AND m.valid && tstzrange(p_at, NULL, '[)')
    -- Retain the native GiST traversal; all matching routes have distance zero.
    ORDER BY m.route <-> p_route
    FOR UPDATE;
BEGIN
  OPEN overlapping;
  LOOP
    FETCH overlapping INTO target;
    EXIT WHEN NOT FOUND;

    IF lower_inf(target.valid) OR lower(target.valid) < p_at THEN
      UPDATE access.organization_member
      SET valid = tstzrange(lower(target.valid), p_at,
                            CASE WHEN lower_inc(target.valid) THEN '[)' ELSE '()' END),
          transaction_id = p_transaction_id
      WHERE CURRENT OF overlapping;
    ELSE
      -- Including lower = T: delete rather than construct an empty range.
      DELETE FROM access.organization_member WHERE CURRENT OF overlapping;
    END IF;
    changed := changed + 1;
  END LOOP;
  CLOSE overlapping;
  RETURN changed;
END;
$$;

-- migrate:down
-- Forward only: completed membership history remains durable.
