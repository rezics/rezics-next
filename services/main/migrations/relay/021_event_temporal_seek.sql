-- Existing immutable handoffs provide Event collection prefixes independently
-- of unrelated Main traffic. The acknowledged prefix excludes partial delivery.
CREATE INDEX checkpoint_stream_tail ON relay.checkpoint (stream_scope,data_epoch,sequence DESC);
CREATE INDEX delivered_event_temporal_actual ON relay.delivered_event (stream_scope,data_epoch,sequence,event_id)
    WHERE envelope->>'type'='com.rezics.event.time-changed.v1'
      AND envelope#>>'{data,receipt,timeStatus}'='actual';
CREATE INDEX delivered_event_temporal_planned ON relay.delivered_event (stream_scope,data_epoch,sequence,event_id)
    WHERE envelope->>'type'='com.rezics.event.time-changed.v1'
      AND envelope#>>'{data,receipt,timeStatus}'='planned';
