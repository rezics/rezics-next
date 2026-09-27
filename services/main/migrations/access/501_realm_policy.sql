ALTER TABLE access.realm_admin_settings
  ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','restricted','private')),
  ADD COLUMN review_mode text NOT NULL DEFAULT 'mandatory' CHECK (review_mode IN ('mandatory','trusted-members','open'));

-- A committed settings intent is recoverable without re-authorizing its effect.
-- Only one undelivered revision per Realm; new settings cannot overtake it.
CREATE TABLE access.realm_policy_delivery (
  realm text PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES access.realm_admin_receipt(id) DEFERRABLE INITIALLY DEFERRED,
  generation bigint NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('public','restricted','private')),
  review_mode text NOT NULL CHECK (review_mode IN ('mandatory','trusted-members','open')),
  delivered boolean NOT NULL DEFAULT false
);
