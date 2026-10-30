INSERT INTO access.realm_membership_reconciliation(route,account_id,barrier_id,after_id,completed)
VALUES (:route::integer,:account_id::uuid,:barrier_id::text,NULLIF(:after_id::text,'')::uuid,:completed::boolean)
ON CONFLICT (route,account_id,barrier_id) DO UPDATE SET after_id=EXCLUDED.after_id,completed=EXCLUDED.completed
WHERE realm_membership_reconciliation.after_id IS NOT DISTINCT FROM NULLIF(:previous_id::text,'')::uuid
 AND NOT realm_membership_reconciliation.completed
RETURNING after_id::text AS "afterId";
