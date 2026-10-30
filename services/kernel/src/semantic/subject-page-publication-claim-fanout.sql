WITH input AS NOT MATERIALIZED (SELECT :lease_until::timestamptz AS lease_until, :partition::integer AS partition),
wanted AS MATERIALIZED (
SELECT q.* FROM input
CROSS JOIN LATERAL generate_series(input.partition*16,input.partition*16+15) home(route)
CROSS JOIN (VALUES ('pending'::text),('leased'::text)) states(state)
CROSS JOIN LATERAL (
SELECT route,owner_kind,owner_key,change_id FROM semantic.subject_page_fanout
WHERE route=home.route AND state=states.state AND available_at<=now()
ORDER BY available_at,owner_kind,owner_key,change_id LIMIT 1 FOR UPDATE SKIP LOCKED
) q ORDER BY q.route,q.owner_kind,q.owner_key,q.change_id LIMIT 1
)
UPDATE semantic.subject_page_fanout r SET version=r.version+1,state='leased',available_at=(SELECT lease_until FROM input),worker=:worker::text,lease_until=(SELECT lease_until FROM input)
FROM wanted WHERE r.route=wanted.route AND r.owner_kind=wanted.owner_kind AND r.owner_key=wanted.owner_key AND r.change_id=wanted.change_id RETURNING r.route,r.owner_kind,r.owner_key,r.change_id,r.version::text,r.source_key,r.effective_at::text,r.evidence;
