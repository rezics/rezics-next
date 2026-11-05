DELETE FROM zones.page_preparation
WHERE route=:route::integer AND zone_id=:zone_id::uuid AND viewer=:viewer::text AND slot=:slot::smallint
 AND generation=:generation::uuid AND revision=:revision::bigint;
