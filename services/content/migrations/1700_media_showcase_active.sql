-- A slot's current revision determines capacity, regardless of source disclosure
-- or clearance. Retained removal heads must still suppress context fallback.
ALTER TABLE media.selection_slot ADD COLUMN showcase_active boolean NOT NULL DEFAULT false;

UPDATE media.selection_slot s SET showcase_active = true
  FROM media.selection_revision r WHERE r.id = s.head AND s.role LIKE 'showcase-%'
    AND (r.use_id IS NOT NULL OR r.trailer_url IS NOT NULL);

CREATE FUNCTION media.derive_showcase_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.showcase_active = NEW.role LIKE 'showcase-%' AND EXISTS (
    SELECT 1 FROM media.selection_revision r WHERE r.id = NEW.head
      AND (r.target, r.context, r.role) = (NEW.target, NEW.context, NEW.role)
      AND (r.use_id IS NOT NULL OR r.trailer_url IS NOT NULL));
  RETURN NEW;
END $$;

-- Derive on every write, including attempts to change only the cached flag.
-- Existing CAS, immutable history and delivery guards remain authoritative.
CREATE TRIGGER selection_slot_showcase_active BEFORE INSERT OR UPDATE ON media.selection_slot
  FOR EACH ROW EXECUTE FUNCTION media.derive_showcase_active();
