-- Unbound representation URLs must not bypass a campaign Use's current Zone
-- reference. This exact-source probe must stay independent of Use inventory.
CREATE INDEX campaign_source_use_idx ON media.use (representation_id)
  WHERE role LIKE 'campaign-%';
