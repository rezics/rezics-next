-- Main eligibility delivery is custody in Content's ordered stream, not a
-- Content policy decision. Keep source progress separate from projection
-- checkpoints, which are keyed by the Content owner's own outbox positions.
INSERT INTO content.receipt_action (action)
VALUES ('publication.eligibility-deliver') ON CONFLICT DO NOTHING;

CREATE TABLE content.eligibility_delivery_progress (
  stream_scope text NOT NULL CHECK (length(stream_scope) BETWEEN 1 AND 300),
  graph_data_epoch uuid NOT NULL,
  content_data_epoch uuid NOT NULL,
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  PRIMARY KEY (stream_scope, graph_data_epoch, content_data_epoch)
);

-- Retain every traversed batch, including batches with no eligibility event.
-- This makes a lost response replayable while preserving contiguous traversal.
CREATE TABLE content.eligibility_delivery_batch (
  stream_scope text NOT NULL,
  graph_data_epoch uuid NOT NULL,
  content_data_epoch uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  batch_id text NOT NULL CHECK (length(batch_id) BETWEEN 1 AND 300),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  selected_events integer NOT NULL CHECK (selected_events BETWEEN 0 AND 100),
  PRIMARY KEY (stream_scope, graph_data_epoch, content_data_epoch, sequence),
  UNIQUE (stream_scope, graph_data_epoch, content_data_epoch, batch_id),
  FOREIGN KEY (stream_scope, graph_data_epoch, content_data_epoch)
    REFERENCES content.eligibility_delivery_progress(stream_scope, graph_data_epoch, content_data_epoch)
);
CREATE TRIGGER eligibility_delivery_batch_immutable
  BEFORE UPDATE OR DELETE ON content.eligibility_delivery_batch
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE TABLE content.eligibility_delivery_source (
  content_data_epoch uuid NOT NULL,
  stream_scope text NOT NULL,
  graph_data_epoch uuid NOT NULL,
  source_event_id text NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 2048),
  source_receipt_id text NOT NULL CHECK (length(source_receipt_id) BETWEEN 1 AND 2048),
  source_sequence text NOT NULL CHECK (source_sequence ~ '^(0|[1-9][0-9]{0,99})$'),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  source_batch_sequence bigint NOT NULL CHECK (source_batch_sequence > 0),
  source_batch_id text NOT NULL CHECK (length(source_batch_id) BETWEEN 1 AND 300),
  source_batch_digest text NOT NULL CHECK (source_batch_digest ~ '^[0-9a-f]{64}$'),
  source_ordinal integer NOT NULL CHECK (source_ordinal >= 0),
  preparation_id text NOT NULL REFERENCES content.publication_preparation(operation_id),
  revision_id uuid NOT NULL REFERENCES content.revision(id),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 300),
  variant_id text NOT NULL REFERENCES content.variant(id),
  publication_decision text NOT NULL CHECK (length(publication_decision) BETWEEN 1 AND 2048),
  eligibility_decision text NOT NULL CHECK (length(eligibility_decision) BETWEEN 1 AND 2048),
  operation_id text NOT NULL UNIQUE REFERENCES content.receipt(operation_id),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (content_data_epoch, source_event_id),
  UNIQUE (content_data_epoch, source_receipt_id),
  FOREIGN KEY (stream_scope, graph_data_epoch, content_data_epoch, source_batch_sequence)
    REFERENCES content.eligibility_delivery_batch(stream_scope, graph_data_epoch, content_data_epoch, sequence),
  FOREIGN KEY (variant_id, revision_id) REFERENCES content.revision(variant_id, id)
);
CREATE INDEX eligibility_delivery_source_receipt_idx
  ON content.eligibility_delivery_source (content_data_epoch, source_receipt_id);
CREATE TRIGGER eligibility_delivery_source_immutable
  BEFORE UPDATE OR DELETE ON content.eligibility_delivery_source
  FOR EACH ROW EXECUTE FUNCTION content.no_mutation();

CREATE FUNCTION content.eligibility_delivery_progress_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.sequence <> 0 THEN
      RAISE EXCEPTION 'eligibility delivery progress must start at zero'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.stream_scope, OLD.graph_data_epoch, OLD.content_data_epoch)
       IS DISTINCT FROM (NEW.stream_scope, NEW.graph_data_epoch, NEW.content_data_epoch)
    OR NEW.sequence <= OLD.sequence
    OR (SELECT count(*) FROM content.eligibility_delivery_batch b
        WHERE b.stream_scope = OLD.stream_scope
          AND b.graph_data_epoch = OLD.graph_data_epoch
          AND b.content_data_epoch = OLD.content_data_epoch
          AND b.sequence > OLD.sequence AND b.sequence <= NEW.sequence)
       <> NEW.sequence - OLD.sequence THEN
    RAISE EXCEPTION 'eligibility delivery progress must advance over contiguous retained batches'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER eligibility_delivery_progress_monotonic
  BEFORE INSERT OR UPDATE ON content.eligibility_delivery_progress
  FOR EACH ROW EXECUTE FUNCTION content.eligibility_delivery_progress_guard();
