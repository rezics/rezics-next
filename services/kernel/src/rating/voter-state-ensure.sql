INSERT INTO rating.voter_state (route, voter_id, state)
VALUES (:route::integer, :voter_id::uuid, 'eligible')
ON CONFLICT (route, voter_id) DO NOTHING;
