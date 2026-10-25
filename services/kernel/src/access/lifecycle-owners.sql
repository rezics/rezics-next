-- Saturated owner cardinality: 2 means at least two. The separate member point
-- probe must still find the target when it is outside those first two owners.
-- Equal-route distance ordering uses native GiST traversal under each LIMIT,
-- preventing LIMIT estimates from favoring a full sequential scan.
-- The temporal primary key allows at most one current target membership; test
-- its role after that point probe so the partial owner index cannot replace it.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :organization_id::uuid AS organization_id,
         :member_id::uuid AS member_id, :at::timestamptz AS at
)
SELECT (SELECT count(*)::integer
        FROM (SELECT 1 FROM access.organization_member
              WHERE route = i.route AND organization_id = i.organization_id
                AND role = 'owner' AND valid @> i.at
              ORDER BY route <-> i.route
              LIMIT 2) AS current_owners) AS owners,
       (SELECT count(*)::integer
        FROM (SELECT role FROM access.organization_member
              WHERE route = i.route AND organization_id = i.organization_id
                AND member_account_id = i.member_id
                AND valid @> i.at
              ORDER BY route <-> i.route
              LIMIT 1) AS target_member
        WHERE role = 'owner') AS target
FROM input i;
