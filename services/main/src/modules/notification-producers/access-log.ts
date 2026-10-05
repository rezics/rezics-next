/** Read the cursor range and its commit horizon in one snapshot. Older recovery
 * epochs are already drained by the recovery fence, even after xid restarts.
 * One (epoch, xid, id) index range returns at most the caller's tick bound. */
export const notificationProducerEventsSql = `SELECT event.epoch::text, event.xid::text,
  event.id::text, event.kind, event.event_id FROM access.notification_producer_event AS event
  WHERE (event.epoch, event.xid, event.id) > ($1::bigint, $2::xid8, $3::bigint)
    AND (event.epoch, event.xid) <
      ((SELECT generation FROM access.recovery_fence WHERE id), pg_snapshot_xmin(pg_current_snapshot()))
  ORDER BY event.epoch, event.xid, event.id LIMIT $4`;
