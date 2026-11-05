WITH zone_type AS MATERIALIZED (
  SELECT 1
  FROM access.resource_initialization
  WHERE route = :route::integer AND resource_id = :zone_id::uuid
    AND resource_type = 'semantic.zone'
), subject AS MATERIALIZED (
  SELECT a.state, a.authn_fenced
  FROM access.account a, zone_type
  WHERE :subject_account_id::nullable(uuid) IS NOT NULL
    AND a.route = :subject_route::nullable(integer)
    AND a.account_id = :subject_account_id::nullable(uuid)
  FOR SHARE OF a
), subject_state AS MATERIALIZED (
  SELECT count(*)::integer AS subject_count, max(state) AS subject_state,
         bool_or(authn_fenced) AS subject_fenced
  FROM subject
), zone AS MATERIALIZED (
  SELECT z.state, z.write_fenced, z.held
  FROM zones.zone z, zone_type, subject_state
  WHERE z.route = :route::integer AND z.zone_id = :zone_id::uuid
  FOR UPDATE OF z
)
SELECT EXISTS (SELECT 1 FROM zone_type) AS "isZone",
       (SELECT state FROM zone LIMIT 1) AS state,
       (SELECT write_fenced FROM zone LIMIT 1) AS "writeFenced",
       (SELECT held FROM zone LIMIT 1) AS held,
       (SELECT subject_count FROM subject_state) AS "subjectCount",
       (SELECT subject_state FROM subject_state) AS "subjectState",
       (SELECT subject_fenced FROM subject_state) AS "subjectFenced";
