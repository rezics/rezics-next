INSERT INTO zones.page_preparation (route,zone_id,viewer,slot,request,basis,generation,revision,position)
SELECT :route::integer,:zone_id::uuid,:viewer::text,:slot::smallint,:request::text,:basis::text,
 :generation::uuid,1,:position::jsonb
WHERE EXISTS (SELECT 1 FROM zones.zone WHERE route=:route::integer AND zone_id=:zone_id::uuid
 AND state='active' AND configuration IS NOT NULL)
ON CONFLICT (route,zone_id,viewer,slot) DO UPDATE
SET request=EXCLUDED.request,basis=EXCLUDED.basis,generation=EXCLUDED.generation,
 revision=zones.page_preparation.revision+1,position=EXCLUDED.position
WHERE (:expected::text IS NULL OR zones.page_preparation.revision=:expected::bigint)
RETURNING revision::text AS revision;
