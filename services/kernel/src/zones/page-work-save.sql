WITH input AS (
 SELECT :route::integer AS route, :zone_id::uuid AS zone_id, :expected::bigint AS expected
)
INSERT INTO zones.page_preparation (route,zone_id,viewer,slot,request,basis,generation,revision,position)
SELECT input.route,input.zone_id,:viewer::text,:slot::smallint,:request::text,:basis::text,
 :generation::uuid,1,:position::jsonb
FROM input
WHERE EXISTS (SELECT 1 FROM zones.zone z WHERE z.route=input.route AND z.zone_id=input.zone_id
 AND z.state='active' AND z.configuration IS NOT NULL)
ON CONFLICT (route,zone_id,viewer,slot) DO UPDATE
SET request=EXCLUDED.request,basis=EXCLUDED.basis,generation=EXCLUDED.generation,
 revision=zones.page_preparation.revision+1,position=EXCLUDED.position
WHERE zones.page_preparation.revision=(SELECT expected FROM input)
RETURNING revision::text AS revision;
