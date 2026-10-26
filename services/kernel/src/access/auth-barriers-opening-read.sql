-- One anchored read on the operator opening, the acting human and the operator account.
-- Rows are located by key: the operator route and id, the receipt, and the human's own route
-- derived from the id exactly as the route constraints do.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :operator_id::uuid AS operator_id, :receipt_id::uuid AS receipt_id,
         :subject_id::uuid AS subject_id, :reservation_id::uuid AS reservation_id,
         :previous_floor::bigint AS previous_floor, :at::timestamptz AS at
)
SELECT true AS ok
FROM input i
JOIN access.operator_opening_receipt r
  ON r.route = i.route AND r.operator_account_id = i.operator_id AND r.receipt_id = i.receipt_id
JOIN access.account h
  ON h.route = get_byte(uuid_send(r.acting_human_id), 10) * 256 + get_byte(uuid_send(r.acting_human_id), 11)
  AND h.account_id = r.acting_human_id
JOIN access.account o ON o.route = r.route AND o.account_id = r.operator_account_id
WHERE r.consumed_at IS NOT NULL AND r.purpose = 'session'
  AND r.subject_account_id = i.subject_id AND r.reservation_id = i.reservation_id
  AND r.subject_epoch_floor = i.previous_floor
  AND h.kind = 'actor' AND h.state = 'active' AND NOT h.authn_fenced AND h.operator_account_id IS NULL
  AND h.minimum_authn_epoch = r.human_epoch_floor
  AND o.state = 'active' AND NOT o.authn_fenced AND o.operator_account_id IS NULL
  AND (
    (o.kind = 'actor' AND o.account_id = h.account_id)
    OR (o.kind = 'organization' AND EXISTS (
      SELECT 1 FROM access.organization_member m
      WHERE m.route = o.route AND m.organization_id = o.account_id AND m.member_account_id = h.account_id
        AND m.valid @> i.at
        -- The grant reaches the human by identity, by the member's role or by every active account.
        AND EXISTS (
          SELECT 1 FROM access.resource_grant g
          WHERE g.route = o.route AND g.resource_id = o.account_id AND g.action = 'account:manage' AND g.valid @> i.at
            AND ((g.subject_kind = 'identity' AND g.subject_id = h.account_id AND g.subject_role = '')
              OR (g.subject_kind = 'identity' AND g.subject_id = o.account_id AND g.subject_role = m.role)
              OR g.subject_kind = 'active_accounts')
        )
        AND NOT EXISTS (
          SELECT 1 FROM access.resource_denial d
          WHERE d.route = o.route AND d.resource_id = o.account_id AND d.action = 'account:manage'
            AND d.valid @> i.at
            AND ((d.subject_id = h.account_id AND d.subject_role = '')
              OR (d.subject_id = o.account_id AND d.subject_role = m.role))
        )
    ))
  );
