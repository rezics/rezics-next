-- migrate:up
-- Disposable bounded page locators. Configuration and membership authority remain in their native owners.
CREATE TABLE zones.page_preparation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  zone_id uuid NOT NULL,
  viewer text COLLATE "C" NOT NULL CHECK (viewer ~ '^[0-9a-f]{64}$'),
  slot smallint NOT NULL CHECK (slot BETWEEN 0 AND 31),
  request text COLLATE "C" NOT NULL CHECK (request ~ '^[0-9a-f]{64}$'),
  basis text COLLATE "C" NOT NULL CHECK (basis ~ '^[0-9a-f]{64}$'),
  generation uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  position jsonb NOT NULL CHECK (octet_length(position::text) <= 1048576),
  PRIMARY KEY (route, zone_id, viewer, slot),
  FOREIGN KEY (route, zone_id) REFERENCES zones.zone (route, zone_id) ON DELETE CASCADE
);
-- Configuration/lifecycle writes invalidate disposable rows in the owning transaction.
CREATE FUNCTION zones.clear_page_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM zones.page_preparation WHERE route=NEW.route AND zone_id=NEW.zone_id;
 RETURN NEW;
END;
$$;
CREATE TRIGGER zone_page_preparation_invalidation AFTER UPDATE OF revision,lifecycle_revision,state,owner_id,
 configuration,mounts,release_digest,withholding ON zones.zone
 FOR EACH ROW EXECUTE FUNCTION zones.clear_page_preparation();
-- migrate:down
DROP TRIGGER zone_page_preparation_invalidation ON zones.zone;
DROP FUNCTION zones.clear_page_preparation();
DROP TABLE zones.page_preparation;
