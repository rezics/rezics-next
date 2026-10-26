INSERT INTO rating.voter_realm (route, voter_id, realm_id, joined_at, state)
VALUES (:route, :voter_id::uuid, :realm_id::uuid, :joined_at::timestamptz, :state::text);
