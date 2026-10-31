SELECT request, basis, generation, revision::text AS revision, position
FROM zones.page_preparation
WHERE route=:route::integer AND zone_id=:zone_id::uuid AND viewer=:viewer::text AND slot=:slot::smallint;
