-- Coverage is the canonical account flag, projected without rereading actor
-- state. This view and the real inverse remain on the admitted actor's anchor.
SELECT c.complete, i.kind, i.group_id::text AS id
FROM access.membership_inverse_coverage c
LEFT JOIN access.membership_inverse i ON i.route = c.route AND i.account_id = c.account_id
WHERE c.route = :route AND c.account_id = :account_id;
