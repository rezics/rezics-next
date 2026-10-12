-- Empty batches have no envelope from which a reader can recover their cut.
ALTER TABLE relay.delivered_batch ADD COLUMN graph_sequence numeric
    CHECK (graph_sequence > 0 AND graph_sequence < 'Infinity'::numeric
        AND graph_sequence = trunc(graph_sequence));

-- Only complete, agreeing retained members prove an old header's graph cut.
-- Empty or damaged headers remain unresolved until source-verified repair.
WITH proven AS (
    SELECT batch.stream_scope, batch.data_epoch, batch.sequence,
        min(event.envelope #>> '{data,sourcePosition,sequence}') AS graph_sequence
    FROM relay.delivered_batch AS batch
    JOIN relay.delivered_event AS event
      ON event.stream_scope = batch.stream_scope AND event.data_epoch = batch.data_epoch
      AND event.sequence = batch.sequence
    WHERE batch.stream_scope = 'urn:rezics:stream:main-rdf' AND batch.event_count > 0
    GROUP BY batch.stream_scope, batch.data_epoch, batch.sequence,
        batch.batch_id, batch.routing_epoch, batch.event_count
    HAVING count(*) = batch.event_count
      AND count(DISTINCT event.envelope #>> '{data,ordinal}') = batch.event_count
      AND count(DISTINCT event.envelope #>> '{data,sourcePosition,sequence}') = 1
      AND bool_and(COALESCE(
        event.envelope #>> '{data,batchId}' = batch.batch_id
        AND event.envelope #>> '{data,routingEpoch}' = batch.routing_epoch
        AND event.envelope #>> '{data,sourcePosition,datasetId}' = 'product'
        AND event.envelope #>> '{data,sourcePosition,dataEpoch}' = batch.data_epoch
        AND event.envelope #>> '{data,sourcePosition,sequence}' ~ '^[1-9][0-9]{0,99}$'
        AND event.envelope #>> '{data,relayPosition,streamScope}' = batch.stream_scope
        AND event.envelope #>> '{data,relayPosition,dataEpoch}' = batch.data_epoch
        AND event.envelope #>> '{data,relayPosition,sequence}' = batch.sequence::text
        AND CASE WHEN event.envelope #>> '{data,ordinal}' ~ '^(0|[1-9][0-9]?)$'
          THEN (event.envelope #>> '{data,ordinal}')::integer < batch.event_count ELSE false END,
        false))
)
UPDATE relay.delivered_batch AS batch SET graph_sequence = proven.graph_sequence::numeric
FROM proven WHERE batch.stream_scope = proven.stream_scope AND batch.data_epoch = proven.data_epoch
    AND batch.sequence = proven.sequence;
