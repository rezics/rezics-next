WITH parameters AS (SELECT $1::uuid generation,$2::uuid original,$3::integer home), removed AS (
 DELETE FROM semantic.identity_epoch_original WHERE partition_no=(SELECT home FROM parameters) AND generation=(SELECT generation FROM parameters)
 AND original=(SELECT original FROM parameters) RETURNING original,terminal
), gates AS (
 DELETE FROM semantic.identity_epoch_home_gate g USING removed r
 WHERE g.route BETWEEN (SELECT home FROM parameters)*16 AND (SELECT home FROM parameters)*16+15 AND g.destination=r.terminal AND g.original=r.original
)
SELECT original FROM removed;
