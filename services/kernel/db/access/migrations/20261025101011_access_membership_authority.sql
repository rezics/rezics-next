-- migrate:up
-- One organization-anchor command owns the slot and supplies its authoritative
-- time. Each iteration changes one actual interval, never completed history.
CREATE FUNCTION access.close_membership_authority(
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
    -- Native GiST traversal under LIMIT avoids a history scan even when a
    -- member's expired intervals dominate the planner's cardinality estimate.
    ORDER BY m.route <-> p_route
    LIMIT 1 FOR UPDATE;
BEGIN
  LOOP
    OPEN overlapping;
    FETCH overlapping INTO target;
    IF NOT FOUND THEN
      CLOSE overlapping;
      EXIT;
    END IF;

    IF lower_inf(target.valid) OR lower(target.valid) < p_at THEN
      UPDATE access.organization_member
      SET valid = tstzrange(lower(target.valid), p_at,
                            CASE WHEN lower_inc(target.valid) THEN '[)' ELSE '()' END),
          transaction_id = p_transaction_id
      WHERE CURRENT OF overlapping;
    ELSE
      -- Including lower = T: no empty range is constructed or stored.
      DELETE FROM access.organization_member WHERE CURRENT OF overlapping;
    END IF;
    CLOSE overlapping;
    changed := changed + 1;
  END LOOP;
  RETURN changed;
END;
$$;

-- migrate:down
-- Forward only: lifecycle commands depend on temporal authority closure.
