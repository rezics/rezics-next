-- migrate:up
-- At most one outstanding interval and its immediate predecessor per original.
-- No Type, permission, winner or identity-repair assertion is stored here.
CREATE TABLE library.collection_kind_raw_input (
  route integer NOT NULL,
  origin_id text NOT NULL,
  preparation_id uuid NOT NULL,
  observation_version bigint NOT NULL CHECK (observation_version >= 0),
  input_id text NOT NULL CHECK (input_id ~ '^sha256:[0-9a-f]{64}$'),
  predecessor text CHECK (predecessor ~ '^sha256:[0-9a-f]{64}$'),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 4096),
  native_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (route,origin_id,observation_version),
  UNIQUE (route,input_id),
  FOREIGN KEY (route,origin_id) REFERENCES library.collection_kind_audience_origin(route,origin_id) ON DELETE CASCADE
);
CREATE FUNCTION library.collection_kind_raw_input_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Collection Kind raw input is immutable';
END;
$$;
CREATE TRIGGER collection_kind_raw_input_immutable BEFORE UPDATE ON library.collection_kind_raw_input
FOR EACH ROW EXECUTE FUNCTION library.collection_kind_raw_input_immutable();


-- Validate on the actual commit boundary, after any awaited caller work. The
-- original/consent/Source locks taken by admission remain held until this runs.
CREATE FUNCTION library.collection_kind_raw_input_commit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE value jsonb := NEW.body::jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM library.collection_kind_audience_origin original
    JOIN library.collection_kind_observation observation
      ON (observation.route,observation.collection_id,observation.audience)=
         (original.route,original.collection_id,original.audience)
    JOIN library.collection_kind_consent_consumer consumer
      ON (consumer.route,consumer.reference_id)=(original.route,value->'enrollment'->>'reference')
    JOIN library.collection collection
      ON (collection.route,collection.collection_id,collection.curator_account_id)=
         (original.route,original.collection_id,original.owner_account_id)
    WHERE original.route=NEW.route AND original.origin_id=NEW.origin_id
      AND original.preparation_id=NEW.preparation_id AND NOT original.cancelled
      AND original.expires_at>clock_timestamp()
      AND original.deadline_at>extract(epoch FROM clock_timestamp())*1000
      AND observation.generation=NEW.preparation_id AND observation.version=NEW.observation_version
      AND observation.capture=original.source_capture AND NOT observation.complete
      AND collection.state='active' AND collection.presentation_kind IS NULL
      AND collection.source_generation=original.source_generation
      AND consumer.origin_id=NEW.origin_id AND consumer.preparation_id=NEW.preparation_id
      AND NOT consumer.invalidated AND consumer.source_generation=original.source_generation
      AND consumer.source_capture=original.source_capture
      AND consumer.enrollment_generation::text=value->'enrollment'->>'generation'
      AND consumer.restore_generation::text=value->'enrollment'->>'restore'
      AND consumer.catalogue_root=value->'enrollment'->>'catalogue'
      AND original.original_digest=value->'original'->>'digest'
      AND original.formula_digest=value->'original'->>'formula'
      AND original.audience=value->'original'->>'audience'
      AND original.origin_id=value->'original'->>'id'
      AND original.source_capture=value->'source'->>'capture'
      AND NEW.preparation_id::text=value->'preparation'->>'id'
      AND NEW.observation_version::text=value->'preparation'->>'version'
      AND NEW.predecessor IS NOT DISTINCT FROM value->'preparation'->>'predecessor'
  ) THEN RAISE EXCEPTION 'Collection Kind raw input commit is stale' USING ERRCODE='40001'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER collection_kind_raw_input_commit
AFTER INSERT ON library.collection_kind_raw_input DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION library.collection_kind_raw_input_commit();

-- migrate:down
DROP TABLE library.collection_kind_raw_input;
DROP FUNCTION library.collection_kind_raw_input_commit();
DROP FUNCTION library.collection_kind_raw_input_immutable();
