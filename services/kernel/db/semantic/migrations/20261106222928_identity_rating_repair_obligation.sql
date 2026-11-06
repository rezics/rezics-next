-- migrate:up
-- Retained Rating identity-repair obligation. Same-home voter commands hold exact
-- original-to-terminal mappings under the partition owner lock until COMMIT, then
-- bind this row to the Rating receipt. Foreign source or control homes persist a
-- preparing row and one-partition prepare/handoff receipts. Later mapping writes
-- mark later_change in bounded pages; votes beyond the captured upper key mark
-- later_vote. Drain writes a retained receipt and bounded continuation.
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
  prepare_homes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(prepare_homes) = 'array' AND jsonb_array_length(prepare_homes) <= 64),
  owner_node text NOT NULL CHECK (octet_length(owner_node) BETWEEN 1 AND 256),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  state text NOT NULL CHECK (state IN ('preparing', 'held', 'bound')),
  later_change boolean NOT NULL DEFAULT false,
  later_vote boolean NOT NULL DEFAULT false,
  receipt_transaction_id uuid,
  drain_receipt_id uuid,
  PRIMARY KEY (partition_no, obligation_id),
  UNIQUE (partition_no, voter_id, page_id),
  CHECK ((state = 'bound') = (receipt_transaction_id IS NOT NULL)),
  CHECK ((through_question_id IS NULL) = (through_target_id IS NULL))
);
CREATE INDEX identity_rating_repair_obligation_originals
  ON semantic.identity_rating_repair_obligation USING gin (originals);
CREATE INDEX identity_rating_repair_obligation_drain
  ON semantic.identity_rating_repair_obligation (partition_no, obligation_id)
  WHERE later_change OR later_vote OR state = 'preparing';

CREATE TABLE semantic.identity_rating_repair_prepare (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  prepare_id uuid NOT NULL,
  voter_partition integer NOT NULL CHECK (voter_partition BETWEEN 0 AND 4095),
  obligation_id uuid NOT NULL,
  originals jsonb NOT NULL CHECK (octet_length(originals::text) <= 16384),
  mappings jsonb NOT NULL CHECK (octet_length(mappings::text) <= 65536),
  extra_homes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(extra_homes) = 'array' AND jsonb_array_length(extra_homes) <= 64),
  owner_node text NOT NULL CHECK (octet_length(owner_node) BETWEEN 1 AND 256),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  later_change boolean NOT NULL DEFAULT false,
  receipt_transaction_id uuid NOT NULL,
  PRIMARY KEY (partition_no, prepare_id),
  UNIQUE (partition_no, obligation_id)
);
CREATE INDEX identity_rating_repair_prepare_originals
  ON semantic.identity_rating_repair_prepare USING gin (originals);

CREATE TABLE semantic.identity_rating_repair_handoff (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  obligation_id uuid NOT NULL,
  home integer NOT NULL CHECK (home BETWEEN 0 AND 4095),
  originals jsonb NOT NULL CHECK (octet_length(originals::text) <= 16384),
  mappings jsonb NOT NULL CHECK (octet_length(mappings::text) <= 65536),
  later_change boolean NOT NULL DEFAULT false,
  receipt_transaction_id uuid NOT NULL,
  PRIMARY KEY (partition_no, obligation_id, home)
);

CREATE TABLE semantic.identity_rating_repair_drain_head (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  overflow boolean NOT NULL DEFAULT false,
  overflow_original uuid
);

CREATE FUNCTION semantic.touch_identity_rating_repair_obligation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  home integer := (NEW.route / 16);
  marked integer;
BEGIN
  WITH picked AS (
    SELECT obligation_id
      FROM semantic.identity_rating_repair_obligation
     WHERE partition_no = home
       AND later_change = false
       AND state IN ('preparing', 'held', 'bound')
       AND originals ? NEW.original::text
     ORDER BY obligation_id
     LIMIT 64
  )
  UPDATE semantic.identity_rating_repair_obligation o
     SET later_change = true
    FROM picked
   WHERE o.partition_no = home
     AND o.obligation_id = picked.obligation_id;
  GET DIAGNOSTICS marked = ROW_COUNT;
  WITH prepared AS (
    SELECT prepare_id
      FROM semantic.identity_rating_repair_prepare
     WHERE partition_no = home
       AND later_change = false
       AND originals ? NEW.original::text
     ORDER BY prepare_id
     LIMIT 64
  )
  UPDATE semantic.identity_rating_repair_prepare p
     SET later_change = true
    FROM prepared
   WHERE p.partition_no = home
     AND p.prepare_id = prepared.prepare_id;
  IF marked = 64 THEN
    INSERT INTO semantic.identity_rating_repair_drain_head(partition_no, overflow, overflow_original)
    VALUES (home, true, NEW.original)
    ON CONFLICT (partition_no) DO UPDATE
      SET overflow = true, overflow_original = EXCLUDED.overflow_original;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER identity_rating_repair_mapping_later_change
AFTER INSERT OR UPDATE OF terminal, epoch, control_partition, control_group ON semantic.identity_epoch_mapping
FOR EACH ROW EXECUTE FUNCTION semantic.touch_identity_rating_repair_obligation();

CREATE FUNCTION semantic.mark_identity_rating_repair_later_vote(
  home integer,
  voter uuid,
  question uuid,
  target uuid
) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  marked integer := 0;
BEGIN
  WITH picked AS (
    SELECT obligation_id
      FROM semantic.identity_rating_repair_obligation
     WHERE partition_no = home
       AND voter_id = voter
       AND later_vote = false
       AND state IN ('preparing', 'held', 'bound')
       AND (
         through_question_id IS NULL
         OR (question, target) > (through_question_id, through_target_id)
       )
     ORDER BY obligation_id
     LIMIT 64
  )
  UPDATE semantic.identity_rating_repair_obligation o
     SET later_vote = true
    FROM picked
   WHERE o.partition_no = home
     AND o.obligation_id = picked.obligation_id;
  GET DIAGNOSTICS marked = ROW_COUNT;
  IF marked = 64 THEN
    INSERT INTO semantic.identity_rating_repair_drain_head(partition_no, overflow)
    VALUES (home, true)
    ON CONFLICT (partition_no) DO UPDATE SET overflow = true;
  END IF;
  RETURN marked;
END;
$$;

-- migrate:down
DROP TRIGGER IF EXISTS identity_rating_repair_mapping_later_change ON semantic.identity_epoch_mapping;
DROP FUNCTION IF EXISTS semantic.touch_identity_rating_repair_obligation();
DROP FUNCTION IF EXISTS semantic.mark_identity_rating_repair_later_vote(integer, uuid, uuid, uuid);
DROP TABLE IF EXISTS semantic.identity_rating_repair_drain_head;
DROP TABLE IF EXISTS semantic.identity_rating_repair_handoff;
DROP TABLE IF EXISTS semantic.identity_rating_repair_prepare;
DROP TABLE IF EXISTS semantic.identity_rating_repair_obligation;
