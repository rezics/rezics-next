-- Disclosure follows the current selection head, independent of delivery
-- clearance and immutable selection history. This is a derived lookup on the
-- existing authoritative slot, not another selection decision.
ALTER TABLE media.selection_slot ADD COLUMN attachment_asset_id uuid REFERENCES media.asset(id);

UPDATE media.selection_slot s SET attachment_asset_id = u.asset_id
  FROM media.selection_revision r JOIN media.use u ON u.id = r.use_id
  WHERE r.id = s.head;

CREATE FUNCTION media.derive_attachment_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.attachment_asset_id = (
    SELECT u.asset_id FROM media.selection_revision r JOIN media.use u ON u.id = r.use_id
    WHERE r.id = NEW.head AND (r.target,r.context,r.role) = (NEW.target,NEW.context,NEW.role));
  RETURN NEW;
END $$;

-- Derive on every write, including attempted edits of only the lookup field.
-- The selection CAS and head guard continue to authorize every head change.
CREATE TRIGGER selection_slot_attachment_asset BEFORE INSERT OR UPDATE ON media.selection_slot
  FOR EACH ROW EXECUTE FUNCTION media.derive_attachment_asset();

CREATE INDEX selection_attachment_asset_idx ON media.selection_slot (attachment_asset_id)
  WHERE attachment_asset_id IS NOT NULL;

-- Match the read's literal predicate so PostgreSQL can seek the partial index
-- without visiting retired avatar/showcase Uses.
-- https://www.postgresql.org/docs/current/indexes-partial.html
CREATE INDEX use_inventory_attachment_idx ON media.use (asset_id,id) INCLUDE (target,context)
  WHERE role <> 'avatar' AND role NOT LIKE 'showcase-%';
