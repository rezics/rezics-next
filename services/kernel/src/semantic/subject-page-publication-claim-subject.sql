WITH input AS NOT MATERIALIZED (SELECT :lease_until::timestamptz AS lease_until, :partition::integer AS partition),
wanted AS MATERIALIZED (
SELECT q.* FROM input
CROSS JOIN LATERAL generate_series(input.partition*16,input.partition*16+15) home(route)
CROSS JOIN (VALUES ('pending'::text),('leased'::text)) states(state)
CROSS JOIN LATERAL (
SELECT route,subject_id FROM semantic.subject_page_repair
WHERE route=home.route AND state=states.state AND available_at<=now()
ORDER BY available_at,subject_id LIMIT 1 FOR UPDATE SKIP LOCKED
) q ORDER BY q.route,q.subject_id LIMIT 1
)
UPDATE semantic.subject_page_repair r SET version=r.version+1,state='leased',available_at=(SELECT lease_until FROM input),worker=:worker::text,lease_until=(SELECT lease_until FROM input)
FROM wanted WHERE r.route=wanted.route AND r.subject_id=wanted.subject_id RETURNING r.route,r.subject_id::text,r.version::text,r.generation::text,r.phase,r.source_key,r.high_water::text,r.replay_position::text;
