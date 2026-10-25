-- migrate:up
ALTER TABLE commerce.purchase_order ADD COLUMN target_subject_id uuid NOT NULL;

CREATE OR REPLACE FUNCTION commerce.guard_order() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    RAISE EXCEPTION 'Recorded checkout session is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement = 'paid' AND NEW.settlement <> 'paid' THEN
    RAISE EXCEPTION 'Paid settlement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION commerce.guard_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route, NEW.order_id, NEW.buyer_account_id, NEW.offer_id, NEW.offer_revision,
      NEW.creator_account_id, NEW.title, NEW.currency, NEW.unit_amount_minor, NEW.tax_code,
      NEW.royalty_basis_points, NEW.created_at)
     IS DISTINCT FROM
     (OLD.route, OLD.order_id, OLD.buyer_account_id, OLD.offer_id, OLD.offer_revision,
      OLD.creator_account_id, OLD.title, OLD.currency, OLD.unit_amount_minor, OLD.tax_code,
      OLD.royalty_basis_points, OLD.created_at) THEN
    RAISE EXCEPTION 'Order identity and captured offer terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_session_id IS NOT NULL AND
     (NEW.checkout_session_id, NEW.checkout_url, NEW.checkout_expires_at)
     IS DISTINCT FROM (OLD.checkout_session_id, OLD.checkout_url, OLD.checkout_expires_at) THEN
    RAISE EXCEPTION 'Recorded checkout session is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement = 'paid' AND NEW.settlement <> 'paid' THEN
    RAISE EXCEPTION 'Paid settlement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE commerce.purchase_order DROP COLUMN target_subject_id;
