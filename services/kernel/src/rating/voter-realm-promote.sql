UPDATE rating.voter_realm AS membership
SET state = 'adding', cursor_question_id = NULL, cursor_target_id = NULL,
    limit_question_id = NULL, limit_target_id = NULL, rejoin = false, transition_id = :transition_id::uuid
FROM (
  SELECT route, voter_id, realm_id FROM rating.voter_realm
  WHERE route = :route AND voter_id = :voter_id::uuid AND state = 'uncounted'
  ORDER BY joined_at, realm_id
  LIMIT 1
) AS candidate
WHERE membership.route = candidate.route AND membership.voter_id = candidate.voter_id
  AND membership.realm_id = candidate.realm_id
RETURNING membership.realm_id::text AS "realmId", membership.transition_id::text AS "transitionId";
