// Only the terminal cursor command emits this event. Payload minimization commits separately.
export const SEMANTIC_LOCATOR_ADVANCED = 'com.rezics.semantic.erasure.locator-advanced.v1';

/** The locator effect commits a completed cursor on its original source home. Pair its terminal event
 * with that durable receipt and the original event epoch. The caller binds the home and source position. */
export const completedLocatorSources = `SELECT delivery.partition_no,delivery.source_position,source.epoch
  FROM semantic.erasure_delivery delivery JOIN core.outbox source
    ON source.partition_no=delivery.partition_no AND source.position=delivery.source_position AND source.event_seq=0
  WHERE delivery.complete AND source.payload_state='present'`;
