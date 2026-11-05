WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :zone_id::uuid AS zone_id,
         :subject_route::nullable(integer) AS subject_route,
         :subject_account_id::nullable(uuid) AS subject_account_id
), zone_type AS MATERIALIZED (
  SELECT 1
  FROM access.resource_initialization r, input i
  WHERE r.route = i.route AND r.resource_id = i.zone_id
    AND r.resource_type = 'semantic.zone'
), subject AS MATERIALIZED (
  SELECT a.state, a.authn_fenced
  FROM access.account a, input i, zone_type
  WHERE i.subject_account_id IS NOT NULL
    AND a.route = i.subject_route AND a.account_id = i.subject_account_id
  FOR SHARE OF a
), subject_state AS MATERIALIZED (
  SELECT count(*)::integer AS subject_count, max(state) AS subject_state,
         bool_or(authn_fenced) AS subject_fenced
  FROM subject
), zone AS MATERIALIZED (
  SELECT z.state, z.write_fenced, z.held
  FROM zones.zone z, input i, zone_type, subject_state
  WHERE z.route = i.route AND z.zone_id = i.zone_id
  FOR UPDATE OF z
)
SELECT EXISTS (SELECT 1 FROM zone_type) AS "isZone",
       (SELECT state FROM zone LIMIT 1) AS state,
       (SELECT write_fenced FROM zone LIMIT 1) AS "writeFenced",
       (SELECT held FROM zone LIMIT 1) AS held,
       (SELECT subject_count FROM subject_state) AS "subjectCount",
       (SELECT subject_state FROM subject_state) AS "subjectState",
       (SELECT subject_fenced FROM subject_state) AS "subjectFenced";
