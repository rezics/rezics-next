-- One anchored read on the subject, its operator opening, the acting human and the operator account.
-- It checks the receipt, the recorded floors and the account states, and returns the principal the opening
-- recorded. It never reads membership, grants, denials or roles: management of the operator is the shared
-- permission evaluator's decision, made on this principal.
-- Rows are located by key: the subject, the operator it names, the receipt, and the human's and operator's
-- own routes derived from the ids exactly as the route constraints do.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :subject_id::uuid AS subject_id, :receipt_id::uuid AS receipt_id,
         :previous_floor::bigint AS previous_floor
)
SELECT o.account_id AS "operatorId", r.acting_human_id AS "humanId", r.client_id AS "clientId", r.scopes,
       r.requested_by AS "requestedBy", r.human_authn_epoch::text AS "humanEpoch", r.action
FROM input i
JOIN access.account s ON s.route = i.route AND s.account_id = i.subject_id
JOIN access.operator_opening_receipt r
  ON r.route = get_byte(uuid_send(s.operator_account_id), 10) * 256 + get_byte(uuid_send(s.operator_account_id), 11)
  AND r.operator_account_id = s.operator_account_id AND r.receipt_id = i.receipt_id
JOIN access.account h
  ON h.route = get_byte(uuid_send(r.acting_human_id), 10) * 256 + get_byte(uuid_send(r.acting_human_id), 11)
  AND h.account_id = r.acting_human_id
JOIN access.account o ON o.route = r.route AND o.account_id = r.operator_account_id
WHERE s.kind = 'actor' AND s.state = 'active'
  AND r.consumed_at IS NOT NULL AND r.purpose = 'session'
  AND r.subject_account_id = i.subject_id AND r.reservation_id = s.operator_reservation_id
  AND r.subject_epoch_floor = i.previous_floor
  AND h.kind = 'actor' AND h.state = 'active' AND NOT h.authn_fenced AND h.operator_account_id IS NULL
  AND h.minimum_authn_epoch = r.human_epoch_floor
  AND o.state = 'active' AND NOT o.authn_fenced AND o.operator_account_id IS NULL;
