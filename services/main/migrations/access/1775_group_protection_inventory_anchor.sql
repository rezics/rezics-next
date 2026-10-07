-- Group effects already serialize and advance generation on this inventory
-- fence (1210). Protection must use the same anchor: upgrading the shared Work
-- scope while another group writer waits on inventory forms a lock cycle.
-- Lock before inspecting protection; retain the group's existence check and
-- the role-family anchor. Taking this fence never advances an authority epoch.
CREATE OR REPLACE FUNCTION access.lock_protection_anchor(anchor_kind text, anchor_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF anchor_kind = 'group' THEN
        PERFORM 1 FROM access.scope_gate g JOIN access.recipient_group r ON r.id = anchor_id
            WHERE g.id = 'access:group-inventory' FOR UPDATE OF g;
    ELSE
        PERFORM 1 FROM access.role_family WHERE id = anchor_id FOR UPDATE;
    END IF;
END $$;
