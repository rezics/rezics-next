-- migrate:up
-- Bounded execution metadata, paid by the existing mapping-generation inventory.
CREATE TABLE semantic.identity_terminal_closure_original (
 partition_no integer NOT NULL CHECK(partition_no BETWEEN 0 AND 4095),
 original_id uuid NOT NULL,
 source_transaction uuid NOT NULL,
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_position bigint NOT NULL CHECK(source_position>0),
 source_generation bigint NOT NULL,
 source_phase text NOT NULL CHECK(source_phase IN ('subjects','members','dirty','member-dirty')),
 operation text NOT NULL CHECK(operation='bootstrap-owner-read'),
 deadline bigint NOT NULL CHECK(deadline>0),
 plan_digest bytea NOT NULL CHECK(octet_length(plan_digest)=32),
 price bigint[] NOT NULL CHECK(array_ndims(price)=1 AND array_lower(price,1)=1 AND cardinality(price)=8 AND array_position(price,NULL) IS NULL),
 spent bigint[] NOT NULL CHECK(array_ndims(spent)=1 AND array_lower(spent,1)=1 AND cardinality(spent)=8 AND array_position(spent,NULL) IS NULL),
 ordinal integer NOT NULL DEFAULT 0 CHECK(ordinal BETWEEN 0 AND 2),
 reservation uuid NOT NULL,
 PRIMARY KEY(partition_no,original_id),
 UNIQUE(partition_no,source_transaction,operation),
 FOREIGN KEY(partition_no,reservation) REFERENCES semantic.identity_epoch_mapping_generation(partition_no,generation),
 CHECK(spent[1] BETWEEN 0 AND price[1] AND spent[2] BETWEEN 0 AND price[2]
   AND spent[3] BETWEEN 0 AND price[3] AND spent[4] BETWEEN 0 AND price[4]
   AND spent[5] BETWEEN 0 AND price[5] AND spent[6] BETWEEN 0 AND price[6]
   AND spent[7] BETWEEN 0 AND price[7] AND spent[8] BETWEEN 0 AND price[8])
);
CREATE INDEX identity_terminal_closure_original_reservation
 ON semantic.identity_terminal_closure_original(partition_no,reservation);

CREATE TABLE semantic.identity_terminal_closure_ticket (
 partition_no integer NOT NULL,
 original_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 2),
 operation text NOT NULL CHECK(operation IN ('owner-read','retire-original')),
 effect_partition integer NOT NULL CHECK(effect_partition BETWEEN 0 AND 4095),
 phase text NOT NULL CHECK(phase IN ('observe-owner','retire-original')),
 cursor_transaction uuid NOT NULL,
 price bigint[] NOT NULL CHECK(array_ndims(price)=1 AND array_lower(price,1)=1 AND cardinality(price)=8 AND array_position(price,NULL) IS NULL
   AND price[1]>=0 AND price[2]>=0 AND price[3]>=0 AND price[4]>=0
   AND price[5]>=0 AND price[6]>=0 AND price[7]>=0 AND price[8]>=0),
 reservation uuid NOT NULL,
 PRIMARY KEY(partition_no,original_id,ordinal),
 FOREIGN KEY(partition_no,original_id) REFERENCES semantic.identity_terminal_closure_original(partition_no,original_id),
 FOREIGN KEY(partition_no,reservation) REFERENCES semantic.identity_epoch_mapping_generation(partition_no,generation),
 CHECK((ordinal=1 AND operation='owner-read' AND phase='observe-owner')
    OR (ordinal=2 AND operation='retire-original' AND phase='retire-original'))
);
CREATE INDEX identity_terminal_closure_ticket_reservation
 ON semantic.identity_terminal_closure_ticket(partition_no,reservation);

CREATE FUNCTION semantic.guard_identity_terminal_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.partition_no,NEW.original_id,NEW.source_transaction,NEW.source_epoch,NEW.source_position,
     NEW.source_generation,NEW.source_phase,NEW.operation,NEW.deadline,NEW.plan_digest,NEW.price,NEW.reservation)
 IS DISTINCT FROM
    (OLD.partition_no,OLD.original_id,OLD.source_transaction,OLD.source_epoch,OLD.source_position,
     OLD.source_generation,OLD.source_phase,OLD.operation,OLD.deadline,OLD.plan_digest,OLD.price,OLD.reservation)
 OR NEW.ordinal<OLD.ordinal
 OR NEW.spent[1]<OLD.spent[1] OR NEW.spent[2]<OLD.spent[2]
 OR NEW.spent[3]<OLD.spent[3] OR NEW.spent[4]<OLD.spent[4]
 OR NEW.spent[5]<OLD.spent[5] OR NEW.spent[6]<OLD.spent[6]
 OR NEW.spent[7]<OLD.spent[7] OR NEW.spent[8]<OLD.spent[8]
 THEN RAISE EXCEPTION 'identity_epoch_unavailable: immutable original or refill'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_terminal_original_immutable BEFORE UPDATE ON semantic.identity_terminal_closure_original
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_terminal_original();
CREATE FUNCTION semantic.guard_identity_terminal_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'identity_epoch_unavailable: immutable spent ticket'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER identity_terminal_ticket_immutable BEFORE UPDATE ON semantic.identity_terminal_closure_ticket
 FOR EACH ROW EXECUTE FUNCTION semantic.guard_identity_terminal_ticket();

-- Point proofs for every retained allocation reference; no page/history scan.
CREATE INDEX identity_terminal_group_allocation
 ON semantic.identity_epoch_group(partition_no,closure_claim) WHERE closure_claim IS NOT NULL;
CREATE INDEX identity_terminal_page_allocation
 ON semantic.identity_epoch_bootstrap_page(partition_no,closure_page_reservation) WHERE closure_page_reservation IS NOT NULL;
CREATE INDEX identity_terminal_directory_allocation
 ON semantic.identity_epoch_original(partition_no,closure_reservation) WHERE closure_reservation IS NOT NULL;
CREATE INDEX identity_terminal_source_allocation
 ON semantic.identity_epoch_mapping((route/16),closure_source_reservation) WHERE closure_source_reservation IS NOT NULL;
CREATE INDEX identity_terminal_successor_allocation
 ON semantic.identity_epoch_mapping((route/16),closure_ticket_reservation) WHERE closure_ticket_reservation IS NOT NULL;

CREATE OR REPLACE FUNCTION semantic.guard_identity_prearm_owner() RETURNS trigger
 LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.node,NEW.epoch,NEW.write_state,NEW.moved_to)
   IS NOT DISTINCT FROM (OLD.node,OLD.epoch,OLD.write_state,OLD.moved_to) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM semantic.identity_epoch_control WHERE partition_no=OLD.partition_no AND prepare_job IS NOT NULL)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_source_hold WHERE partition_no=OLD.partition_no AND NOT closed)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_bootstrap_row WHERE partition_no=OLD.partition_no)
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_mapping WHERE route BETWEEN OLD.partition_no*16 AND OLD.partition_no*16+15
   AND (closure_state<>'legacy' OR closure_successor_ticket IS NOT NULL))
 OR EXISTS(SELECT 1 FROM semantic.identity_epoch_group WHERE partition_no=OLD.partition_no AND closure_claim IS NOT NULL)
 OR EXISTS(SELECT 1 FROM semantic.identity_terminal_closure_original WHERE partition_no=OLD.partition_no)
 THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Native original custody requires forward retirement'; END; $$;
