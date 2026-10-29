WITH parameters AS (SELECT $1::uuid generation,$2::uuid original), removed AS (
 DELETE FROM semantic.identity_epoch_original WHERE generation=(SELECT generation FROM parameters)
 AND original=(SELECT original FROM parameters) RETURNING original,terminal
), gates AS (
 DELETE FROM semantic.identity_epoch_home_gate g USING removed r
 WHERE g.destination=r.terminal AND g.original=r.original
)
SELECT original FROM removed;
