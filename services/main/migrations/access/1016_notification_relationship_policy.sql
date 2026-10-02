-- Delivery provenance, never a grant or a copy of words/name/address data.
ALTER TABLE access.notification_digest_candidate ADD COLUMN actor_agent text,
  ADD COLUMN related_resource text;
