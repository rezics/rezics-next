WITH input AS NOT MATERIALIZED (SELECT :lease_until::timestamptz AS lease_until),
wanted AS (
SELECT partition_no FROM semantic.subject_page_bootstrap WHERE partition_no=:partition::integer AND
(state='pending' AND available_at<=now() OR state='leased' AND lease_until<=now()) FOR UPDATE SKIP LOCKED
) UPDATE semantic.subject_page_bootstrap r SET version=r.version+1,state='leased',available_at=(SELECT lease_until FROM input),worker=:worker::text,lease_until=(SELECT lease_until FROM input)
FROM wanted WHERE r.partition_no=wanted.partition_no RETURNING r.version::text,r.source_key;
