-- migrate:up
-- Retained Rating identity-repair obligation. Same-home voter commands hold exact
-- original-to-terminal mappings under the partition owner lock until COMMIT, then
-- bind this row to the Rating receipt. Later mapping writes on those originals
-- mark later_change. Votes beyond the captured upper key stay on through_*.
CREATE TABLE semantic.identity_rating_repair_obligation (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  obligation_id uuid NOT NULL,
  voter_id uuid NOT NULL,
  work_id uuid NOT NULL,
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,17}$'),
  page_id uuid NOT NULL,
  page_digest text NOT NULL CHECK (page_digest ~ '^[a-f0-9]{64}$'),
  mapping_digest text NOT NULL CHECK (mapping_digest ~ '^[a-f0-9]{64}$'),
  mappings jsonb NOT NULL CHECK (octet_length(mappings::text) <= 65536),
  originals jsonb NOT NULL CHECK (octet_length(originals::text) <= 16384),
  through_question_id uuid,
  through_target_id uuid,
  owner_node text NOT NULL CHECK (octet_length(owner_node) BETWEEN 1 AND 256),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  state text NOT NULL CHECK (state IN ('held', 'bound')),
  later_change boolean NOT NULL DEFAULT false,
  receipt_transaction_id uuid,
  PRIMARY KEY (partition_no, obligation_id),
  UNIQUE (partition_no, voter_id, page_id),
  CHECK ((state = 'held') = (receipt_transaction_id IS NULL)),
  CHECK ((through_question_id IS NULL) = (through_target_id IS NULL))
);
CREATE INDEX identity_rating_repair_obligation_originals
  ON semantic.identity_rating_repair_obligation USING gin (originals);

CREATE FUNCTION semantic.touch_identity_rating_repair_obligation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  home integer := (NEW.route / 16);
BEGIN
  UPDATE semantic.identity_rating_repair_obligation
     SET later_change = true
   WHERE partition_no = home
     AND state IN ('held', 'bound')
     AND originals ? NEW.original::text;
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_rating_repair_mapping_later_change
AFTER INSERT OR UPDATE OF terminal, epoch, control_partition, control_group ON semantic.identity_epoch_mapping
FOR EACH ROW EXECUTE FUNCTION semantic.touch_identity_rating_repair_obligation();

-- migrate:down
DROP TRIGGER IF EXISTS identity_rating_repair_mapping_later_change ON semantic.identity_epoch_mapping;
DROP FUNCTION IF EXISTS semantic.touch_identity_rating_repair_obligation();
DROP TABLE semantic.identity_rating_repair_obligation;
