INSERT INTO rating.erasure_page (route, voter_id, page_id, terminal, had_votes)
VALUES (:route::integer, :voter_id::uuid, :page_id::uuid, :terminal::boolean, :had_votes::boolean)
ON CONFLICT (route, voter_id, page_id) DO NOTHING;
