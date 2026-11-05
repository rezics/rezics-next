-- migrate:up
-- Independent native scheduling tables: the verified original restore record is
-- bound at runtime, after all restore migrations. No physical proof is inferred.
CREATE TABLE auth_restore_live_generation (
  generation text PRIMARY KEY CHECK(octet_length(generation) BETWEEN 1 AND 1024),
  inventory jsonb NOT NULL CHECK(octet_length(inventory::text)<=16384),
  source_cut_id uuid NOT NULL,
  live_partition integer NOT NULL DEFAULT 0 CHECK(live_partition BETWEEN 0 AND 4095),
  live_verified_partitions integer NOT NULL DEFAULT 0 CHECK(live_verified_partitions BETWEEN 0 AND 4096),
  reconcile_turn integer NOT NULL DEFAULT 0 CHECK(reconcile_turn IN (0,1)),
  replay_after bigint NOT NULL DEFAULT 0 CHECK(replay_after>=0),
  replay_inventory_after bigint NOT NULL DEFAULT 0 CHECK(replay_inventory_after>=0),
  replay_inventory_complete boolean NOT NULL DEFAULT false
);
CREATE TABLE auth_restore_live_partition (
  generation text NOT NULL REFERENCES auth_restore_live_generation(generation),
  partition integer NOT NULL CHECK(partition BETWEEN 0 AND 4095),
  arm jsonb NOT NULL CHECK(octet_length(arm::text)<=8192),
  after_ordinal bigint NOT NULL CHECK(after_ordinal>=0),
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  page jsonb CHECK(octet_length(page::text)<=65536),
  verification jsonb CHECK(octet_length(verification::text)<=8192),
  verified boolean NOT NULL DEFAULT false,
  PRIMARY KEY(generation,partition)
);
-- Indexed fair scheduling, separate from immutable original Auth progress.
CREATE TABLE auth_restore_live_work (
  generation text NOT NULL REFERENCES auth_restore_live_generation(generation),
  obligation_id bigint NOT NULL CHECK(obligation_id>0),
  state text NOT NULL DEFAULT 'native' CHECK(state IN ('native','receiving','external')),
  PRIMARY KEY(generation,obligation_id)
);
CREATE INDEX auth_restore_live_work_pending ON auth_restore_live_work(generation,obligation_id) WHERE state<>'external';
CREATE INDEX auth_restore_live_work_state ON auth_restore_live_work(generation,state,obligation_id);
CREATE FUNCTION auth_restore_live_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'Auth live receiver is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='auth_restore_live_generation' THEN
    IF NEW.inventory IS DISTINCT FROM OLD.inventory OR NEW.source_cut_id IS DISTINCT FROM OLD.source_cut_id
      OR NEW.replay_inventory_after<OLD.replay_inventory_after
      OR (OLD.replay_inventory_complete AND NOT NEW.replay_inventory_complete) THEN
      RAISE EXCEPTION 'Auth live inventory binding is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='auth_restore_live_partition' THEN
    IF NEW.partition IS DISTINCT FROM OLD.partition OR NEW.arm IS DISTINCT FROM OLD.arm
      OR NEW.after_ordinal<OLD.after_ordinal OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Auth live Source checkpoint is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
    OR (OLD.state='external' AND NEW.state<>'external') THEN
    RAISE EXCEPTION 'Auth live native work identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_restore_live_immutable BEFORE UPDATE OR DELETE ON auth_restore_live_generation
  FOR EACH ROW EXECUTE FUNCTION auth_restore_live_immutable();
CREATE TRIGGER auth_restore_live_immutable BEFORE UPDATE OR DELETE ON auth_restore_live_partition
  FOR EACH ROW EXECUTE FUNCTION auth_restore_live_immutable();
CREATE TRIGGER auth_restore_live_immutable BEFORE UPDATE OR DELETE ON auth_restore_live_work
  FOR EACH ROW EXECUTE FUNCTION auth_restore_live_immutable();
-- migrate:down
-- Forward only: receiver enrollment and original native work cannot be forgotten.
