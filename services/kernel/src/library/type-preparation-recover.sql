SELECT p.route, p.account_id::text AS "accountId", p.preparation_id::text AS "preparationId",
       p.chunk::text AS chunk, p.byte_offset::text AS offset,
       h.binding, h.origin, h.source_identity AS "sourceIdentity", h.origin_identity AS "originIdentity",
       h.reservation_id::text AS "reservationId"
FROM library.type_preparation_progress AS p
JOIN library.type_preparation_header AS h USING (route, account_id, preparation_id)
WHERE p.state = 'pending' AND p.enqueue_pending
  AND (p.route, p.account_id, p.preparation_id) > (:after_route::integer, :after_account::uuid, :after_preparation::uuid)
ORDER BY p.route, p.account_id, p.preparation_id LIMIT 100;
