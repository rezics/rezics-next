SELECT e.version, ack.outcome
FROM access.erasure AS e
JOIN access.account AS a USING (route, account_id)
LEFT JOIN access.erasure_acknowledgement AS ack
  ON ack.route = e.route AND ack.account_id = e.account_id AND ack.participant = 'library'
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid
  AND a.state = 'deleted' AND a.authn_fenced
LIMIT 1
FOR SHARE OF a, e;
