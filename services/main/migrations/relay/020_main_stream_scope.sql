-- The existing retained prefix belongs to Main's one fixed RDF relay stream.
-- Keep its sequence values, including zero-event batches and crash-delivered rows.
ALTER TABLE relay.checkpoint ADD COLUMN stream_scope text NOT NULL
    DEFAULT 'urn:rezics:stream:main-rdf' CHECK (stream_scope <> '');
ALTER TABLE relay.delivered_batch ADD COLUMN stream_scope text NOT NULL
    DEFAULT 'urn:rezics:stream:main-rdf' CHECK (stream_scope <> '');
ALTER TABLE relay.delivered_event ADD COLUMN stream_scope text NOT NULL
    DEFAULT 'urn:rezics:stream:main-rdf' CHECK (stream_scope <> '');

ALTER TABLE relay.delivered_batch DROP CONSTRAINT delivered_batch_pkey;
ALTER TABLE relay.delivered_batch ADD PRIMARY KEY (stream_scope, data_epoch, sequence);
ALTER TABLE relay.delivered_event DROP CONSTRAINT delivered_event_pkey;
ALTER TABLE relay.delivered_event ADD PRIMARY KEY (stream_scope, source, event_id);
DROP INDEX relay.delivered_event_position;
CREATE INDEX delivered_event_position ON relay.delivered_event (stream_scope, data_epoch, sequence);

-- Retained envelope bytes participate in sealed recovery digests. Keep them
-- unchanged; the relay attaches the migrated row's position when replaying it.
