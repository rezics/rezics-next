INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state, transition_id)
VALUES (:route, :voter_id::uuid, :realm_id::uuid, :joined_at::timestamptz, :state::text, :transition_id::uuid);
