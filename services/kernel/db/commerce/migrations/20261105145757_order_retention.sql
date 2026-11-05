-- migrate:up
-- A finite retained Checkout capability is separated from the minimal financial order root.
ALTER TABLE commerce.purchase_order
  ADD COLUMN checkout_minimized_at timestamptz;
ALTER TABLE commerce.purchase_order
  DROP CONSTRAINT purchase_order_check2,
  ADD CONSTRAINT purchase_order_checkout_state_check CHECK (
    (checkout_session_id IS NULL AND checkout_url IS NULL AND checkout_expires_at IS NULL AND checkout_minimized_at IS NULL)
    OR (checkout_session_id IS NOT NULL AND checkout_url IS NOT NULL AND checkout_expires_at IS NOT NULL AND checkout_minimized_at IS NULL)
    OR (checkout_session_id IS NOT NULL AND checkout_url IS NULL AND checkout_expires_at IS NULL AND checkout_minimized_at IS NOT NULL)
  );

CREATE TABLE commerce.purchase_order_retention_policy (
  route integer NOT NULL,
  order_id uuid NOT NULL,
  buyer_account_id uuid NOT NULL,
  fields text[] NOT NULL CHECK (fields = ARRAY['buyer_account_id','checkout_url','expires_at']::text[]),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (route, order_id),
  FOREIGN KEY (route, order_id) REFERENCES commerce.purchase_order(route, order_id) ON DELETE CASCADE,
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11)),
  CHECK (route = get_byte(uuid_send(buyer_account_id), 10) * 256 + get_byte(uuid_send(buyer_account_id), 11))
);
CREATE INDEX purchase_order_retention_policy_buyer
  ON commerce.purchase_order_retention_policy(route, buyer_account_id, order_id);

CREATE TABLE commerce.purchase_order_retained (
  route integer NOT NULL,
  order_id uuid NOT NULL,
  buyer_account_id uuid NOT NULL,
  checkout_url text NOT NULL,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  PRIMARY KEY (route, order_id),
  FOREIGN KEY (route, order_id) REFERENCES commerce.purchase_order(route, order_id) ON DELETE CASCADE,
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11)),
  CHECK (route = get_byte(uuid_send(buyer_account_id), 10) * 256 + get_byte(uuid_send(buyer_account_id), 11))
);
CREATE INDEX purchase_order_retained_buyer_page
  ON commerce.purchase_order_retained(route, buyer_account_id, order_id);

ALTER TABLE commerce.erasure_progress
  DROP CONSTRAINT erasure_progress_phase_check,
  ADD COLUMN retention_store text,
  ADD COLUMN retention_fields text[],
  ADD COLUMN retention_purpose text,
  ADD COLUMN retention_expires_at timestamptz,
  ADD CONSTRAINT erasure_progress_phase_check CHECK (
    phase IN ('entitlements','acquisitions','money-observations','orders','retained','resolve','pending','none')
  ),
  ADD CONSTRAINT erasure_progress_retention_check CHECK (
    (retention_store IS NULL AND retention_fields IS NULL AND retention_purpose IS NULL AND retention_expires_at IS NULL)
    OR (retention_store = 'commerce.purchase_order_retained' AND retention_fields IS NOT NULL
        AND retention_purpose IS NOT NULL AND retention_expires_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION commerce.guard_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  retention_copy_allowed boolean := false;
BEGIN
  IF (NEW.route, NEW.order_id, NEW.buyer_account_id, NEW.offer_id, NEW.offer_revision,
      NEW.creator_account_id, NEW.title, NEW.currency, NEW.unit_amount_minor, NEW.tax_code,
      NEW.royalty_basis_points, NEW.created_at, NEW.target_subject_id)
     IS DISTINCT FROM
     (OLD.route, OLD.order_id, OLD.buyer_account_id, OLD.offer_id, OLD.offer_revision,
      OLD.creator_account_id, OLD.title, OLD.currency, OLD.unit_amount_minor, OLD.tax_code,
      OLD.royalty_basis_points, OLD.created_at, OLD.target_subject_id) THEN
    RAISE EXCEPTION 'Order identity and captured offer terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_session_id IS NOT NULL AND
     (NEW.checkout_session_id, NEW.checkout_url, NEW.checkout_expires_at)
     IS DISTINCT FROM (OLD.checkout_session_id, OLD.checkout_url, OLD.checkout_expires_at) THEN
    SELECT EXISTS (
      SELECT 1
      FROM access.account a
      JOIN access.erasure e ON (e.route,e.account_id)=(a.route,a.account_id)
      WHERE a.route=OLD.route AND a.account_id=OLD.buyer_account_id AND a.state='deleted'
        AND OLD.checkout_minimized_at IS NULL AND NEW.checkout_minimized_at IS NOT NULL
        AND e.at=NEW.checkout_minimized_at
        AND NEW.checkout_session_id=OLD.checkout_session_id
        AND OLD.checkout_url IS NOT NULL AND OLD.checkout_expires_at IS NOT NULL
        AND NEW.checkout_url IS NULL AND NEW.checkout_expires_at IS NULL
        AND EXISTS (SELECT 1 FROM commerce.purchase_order_retention_policy p
          WHERE (p.route,p.order_id,p.buyer_account_id)=(OLD.route,OLD.order_id,OLD.buyer_account_id))
        AND EXISTS (SELECT 1 FROM commerce.purchase_order_retained r
            WHERE (r.route,r.order_id,r.buyer_account_id)=(OLD.route,OLD.order_id,OLD.buyer_account_id)
              AND r.checkout_url=OLD.checkout_url)
    ) INTO retention_copy_allowed;
    IF NOT retention_copy_allowed THEN
      RAISE EXCEPTION 'Recorded checkout session is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.checkout_minimized_at IS DISTINCT FROM OLD.checkout_minimized_at THEN
    RAISE EXCEPTION 'Checkout minimization requires the exact recorded Session' USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_minimized_at IS NOT NULL AND NEW.checkout_minimized_at IS DISTINCT FROM OLD.checkout_minimized_at THEN
    RAISE EXCEPTION 'Checkout minimization is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement = 'paid' AND NEW.settlement <> 'paid' THEN
    RAISE EXCEPTION 'Paid settlement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
-- Forward only: retained Checkout data and financial roots must not be reconstructed or discarded.
