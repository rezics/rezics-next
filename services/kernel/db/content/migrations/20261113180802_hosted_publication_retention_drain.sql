-- Keep completed Book cleanup stages out of the due index while adopting old rows in bounded keyset pages.
ALTER TABLE content.hosted_publication_retention_cursor
  RENAME COLUMN after_expires_at TO after_available_at;

CREATE TABLE content.hosted_publication_retention_pending (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  available_at timestamptz NOT NULL CHECK (isfinite(available_at)),
  PRIMARY KEY (route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11))
);

CREATE INDEX hosted_publication_retention_pending_due
  ON content.hosted_publication_retention_pending(available_at,route,catalogue_id,stage_id);

CREATE TABLE content.hosted_publication_retention_adoption_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_route integer,
  after_catalogue_id uuid,
  after_stage_id uuid,
  complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
  CHECK (
    (after_route IS NULL AND after_catalogue_id IS NULL AND after_stage_id IS NULL)
    OR
    (after_route BETWEEN 0 AND 65535 AND after_catalogue_id IS NOT NULL AND after_stage_id IS NOT NULL
      AND after_route=get_byte(uuid_send(after_catalogue_id),10)*256+get_byte(uuid_send(after_catalogue_id),11)
      AND after_route=get_byte(uuid_send(after_stage_id),10)*256+get_byte(uuid_send(after_stage_id),11))
  )
);
INSERT INTO content.hosted_publication_retention_adoption_cursor(singleton) VALUES (true);

CREATE FUNCTION content.register_hosted_publication_retention_pending()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO content.hosted_publication_retention_pending(route,catalogue_id,stage_id,available_at)
  VALUES (NEW.route,NEW.catalogue_id,NEW.stage_id,NEW.expires_at)
  ON CONFLICT (route,catalogue_id,stage_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_publication_retention_pending_insert
  AFTER INSERT ON content.hosted_publication_staging
  FOR EACH ROW EXECUTE FUNCTION content.register_hosted_publication_retention_pending();

DROP INDEX content.hosted_publication_staging_retention_expiry;

-- migrate:down
CREATE INDEX hosted_publication_staging_retention_expiry
  ON content.hosted_publication_staging(expires_at,route,catalogue_id,stage_id);
DROP TRIGGER hosted_publication_retention_pending_insert ON content.hosted_publication_staging;
DROP FUNCTION content.register_hosted_publication_retention_pending();
DROP TABLE content.hosted_publication_retention_adoption_cursor;
DROP INDEX content.hosted_publication_retention_pending_due;
DROP TABLE content.hosted_publication_retention_pending;
ALTER TABLE content.hosted_publication_retention_cursor
  RENAME COLUMN after_available_at TO after_expires_at;
