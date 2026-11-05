-- Probe at most the admitted neighborhood plus an overflow sentinel. An
-- overflow refuses the page; it never certifies a truncated account.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id, :after_id::text AS after_id, :sentinel::integer AS sentinel), neighborhood AS MATERIALIZED (
 SELECT m.* FROM access.membership_inverse m
 WHERE m.route=(SELECT route FROM input) AND m.account_id=(SELECT account_id FROM input) AND m.kind='realm'
 ORDER BY m.group_id LIMIT 1001
), selected AS (
SELECT h.reservation_id::text AS "reservationId", h.related_account_id::text AS "realmId",
       h.transaction_id::text AS "holdTransactionId",
       (m.reservation_id=h.reservation_id AND m.transaction_id=h.transaction_id) AS "provenanceValid",
       (SELECT count(*)<=1000 FROM neighborhood) AS admitted
FROM access.lifecycle_coordination h
JOIN neighborhood m ON m.route=h.route AND m.account_id=h.account_id AND m.group_id=h.related_account_id
WHERE h.route=(SELECT route FROM input) AND h.account_id=(SELECT account_id FROM input) AND h.purpose='membership'
 AND NOT EXISTS (SELECT 1 FROM access.realm_membership_transition t
  WHERE t.route=h.route AND t.account_id=h.account_id AND t.generation_id=h.reservation_id AND NOT t.legacy)
 AND (NULLIF((SELECT after_id FROM input),'')::uuid IS NULL OR h.reservation_id>NULLIF((SELECT after_id FROM input),'')::uuid)
ORDER BY h.reservation_id LIMIT (SELECT sentinel FROM input)
)
SELECT * FROM selected
UNION ALL
-- An empty hold page must still refuse an overflowing neighborhood. Otherwise
-- an opaque cursor past the last selected hold could conceal overflow.
(SELECT m.reservation_id::text, m.group_id::text, m.transaction_id::text, false, false
 FROM neighborhood m
 WHERE (SELECT count(*)>1000 FROM neighborhood) AND NOT EXISTS (SELECT 1 FROM selected)
 LIMIT 1)
ORDER BY "reservationId";
