-- migrate:up
-- Erasure admission uses point lookups on every client reduction step.
-- Reserve bucket space for new clients so repeated fence checks can avoid overflow pages.
CREATE INDEX auth_client_id_point ON auth_client USING hash (client_id) WITH (fillfactor=50);

-- Page and owner steps require an unfinished operation, even when replayed.
CREATE INDEX auth_client_reduction_progress_open ON auth_client_reduction_progress (operation_id) WHERE NOT completed;

-- Role drains seek a concrete role value. Receipts without that role need no index entry.
DROP INDEX erasure_auth_effect_receipt_1, erasure_auth_effect_receipt_2, erasure_auth_effect_receipt_3,
  native_role_auth_effect_receipt_0, native_role_auth_effect_receipt_1;
CREATE INDEX erasure_auth_effect_receipt_1 ON auth_effect_receipt (acting_human_id, receipt_id)
  WHERE acting_human_id IS NOT NULL;
CREATE INDEX erasure_auth_effect_receipt_2 ON auth_effect_receipt (client_id, receipt_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX erasure_auth_effect_receipt_3 ON auth_effect_receipt (erasure_operator_id, receipt_id)
  WHERE erasure_operator_id IS NOT NULL;
CREATE INDEX native_role_auth_effect_receipt_0 ON auth_effect_receipt (erasure_client_owner_id, receipt_id)
  WHERE erasure_client_owner_id IS NOT NULL;
CREATE INDEX native_role_auth_effect_receipt_1 ON auth_effect_receipt (erasure_source_client_owner_id, receipt_id)
  WHERE erasure_source_client_owner_id IS NOT NULL;

CREATE OR REPLACE FUNCTION auth_erasure_guard_auth_client_reduction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.client_id IS DISTINCT FROM NEW.client_id THEN
    PERFORM auth_erasure_admit_client(OLD.client_id);
  END IF;
  PERFORM auth_erasure_admit_client(NEW.client_id);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth_erasure_guard_auth_client_reduction_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.client_id IS DISTINCT FROM NEW.client_id THEN
    PERFORM auth_erasure_admit_client(OLD.client_id);
  END IF;
  PERFORM auth_erasure_admit_client(NEW.client_id);
  RETURN NEW;
END $$;

-- migrate:down
DROP INDEX auth_client_id_point, auth_client_reduction_progress_open;

DROP INDEX erasure_auth_effect_receipt_1, erasure_auth_effect_receipt_2, erasure_auth_effect_receipt_3,
  native_role_auth_effect_receipt_0, native_role_auth_effect_receipt_1;
CREATE INDEX erasure_auth_effect_receipt_1 ON auth_effect_receipt (acting_human_id, receipt_id);
CREATE INDEX erasure_auth_effect_receipt_2 ON auth_effect_receipt (client_id, receipt_id);
CREATE INDEX erasure_auth_effect_receipt_3 ON auth_effect_receipt (erasure_operator_id, receipt_id);
CREATE INDEX native_role_auth_effect_receipt_0 ON auth_effect_receipt (erasure_client_owner_id, receipt_id);
CREATE INDEX native_role_auth_effect_receipt_1 ON auth_effect_receipt (erasure_source_client_owner_id, receipt_id);

CREATE OR REPLACE FUNCTION auth_erasure_guard_auth_client_reduction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION auth_erasure_guard_auth_client_reduction_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;
