-- migrate:up
-- Preparation generations are opaque UUIDs from the actual observation producer.
ALTER TABLE library.collection_kind_consent_consumer
  DROP CONSTRAINT collection_kind_consent_consumer_check2;

-- Private original associations expire with the actual first request. They confer no read authority.
CREATE TABLE library.collection_kind_audience_origin (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  origin_id text NOT NULL CHECK (octet_length(origin_id) BETWEEN 1 AND 255),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  audience text NOT NULL CHECK (octet_length(audience) BETWEEN 1 AND 256),
  original_digest text NOT NULL CHECK (original_digest ~ '^sha256:[0-9a-f]{64}$'),
  formula_digest text NOT NULL CHECK (formula_digest ~ '^sha256:[0-9a-f]{64}$'),
  source_generation bigint NOT NULL CHECK (source_generation >= 0),
  source_capture text NOT NULL CHECK (octet_length(source_capture) BETWEEN 1 AND 4096),
  origin_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deadline_at bigint NOT NULL CHECK (deadline_at > 0),
  cancelled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route,origin_id),
  UNIQUE (route,collection_id,audience),
  FOREIGN KEY (route,collection_id,audience)
    REFERENCES library.collection_kind_observation(route,collection_id,audience) ON DELETE CASCADE,
  CHECK (route=get_byte(uuid_send(collection_id),10)*256+get_byte(uuid_send(collection_id),11)),
  CHECK (route=get_byte(uuid_send(owner_account_id),10)*256+get_byte(uuid_send(owner_account_id),11))
);
-- Account erasure already removes observations by their owner, cascading these controls.
CREATE INDEX collection_kind_audience_origin_owner
  ON library.collection_kind_audience_origin(route,owner_account_id,collection_id,preparation_id);

CREATE FUNCTION library.collection_kind_original_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'cancelled') IS DISTINCT FROM (to_jsonb(OLD)-'cancelled')
     OR (OLD.cancelled AND NOT NEW.cancelled) THEN
    RAISE EXCEPTION 'Collection Kind original association is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_kind_original_immutable
BEFORE UPDATE ON library.collection_kind_audience_origin
FOR EACH ROW EXECUTE FUNCTION library.collection_kind_original_immutable();

CREATE FUNCTION library.collection_kind_original_cancel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.invalidated
     OR NEW.enrollment_generation IS DISTINCT FROM OLD.enrollment_generation
     OR NEW.restore_generation IS DISTINCT FROM OLD.restore_generation THEN
    UPDATE library.collection_kind_audience_origin SET cancelled=true
    WHERE route=OLD.route AND origin_id=OLD.origin_id
      AND owner_account_id=OLD.owner_account_id AND collection_id=OLD.collection_id
      AND preparation_id=OLD.preparation_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER collection_kind_original_cancel
AFTER UPDATE OR DELETE ON library.collection_kind_consent_consumer
FOR EACH ROW EXECUTE FUNCTION library.collection_kind_original_cancel();

-- migrate:down
DROP TRIGGER collection_kind_original_cancel ON library.collection_kind_consent_consumer;
DROP FUNCTION library.collection_kind_original_cancel();
DROP TABLE library.collection_kind_audience_origin;
DROP FUNCTION library.collection_kind_original_immutable();
ALTER TABLE library.collection_kind_consent_consumer
  ADD CONSTRAINT collection_kind_consent_consumer_check2
  CHECK (route=get_byte(uuid_send(preparation_id),10)*256+get_byte(uuid_send(preparation_id),11));
