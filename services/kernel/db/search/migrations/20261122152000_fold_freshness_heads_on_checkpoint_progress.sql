-- migrate:up
CREATE OR REPLACE FUNCTION search.group_freshness_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE folded jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.consumer,OLD.partition_no,OLD.position)=(NEW.consumer,NEW.partition_no,NEW.position) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' AND OLD.position>0 AND starts_with(OLD.consumer,'search_')
     AND (TG_OP='DELETE' OR NEW.position=0 OR (OLD.consumer,OLD.partition_no)<>(NEW.consumer,NEW.partition_no)) THEN
    DELETE FROM search.freshness_positions WHERE consumer=OLD.consumer AND shard=OLD.partition_no;
    PERFORM search.write_freshness_slot(OLD.consumer,OLD.partition_no,0);
  END IF;
  IF TG_OP<>'DELETE' AND starts_with(NEW.consumer,'search_') THEN
    IF NEW.position>0 THEN
      INSERT INTO search.freshness_positions(consumer,shard,positions)
        VALUES (NEW.consumer,NEW.partition_no,jsonb_build_object(NEW.partition_no,NEW.position))
        ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions;
      PERFORM search.write_freshness_slot(NEW.consumer,NEW.partition_no,NEW.position);
    END IF;
    -- A first replay batch can insert a zero checkpoint and advance it in this same
    -- transaction. Taking the head group on insert would invert the subsequent
    -- consumer-group then head-group order. The pending point already serves all readers.
    IF TG_OP = 'INSERT' THEN RETURN NULL; END IF;
    UPDATE search.freshness_positions SET pending=false WHERE consumer='' AND shard=NEW.partition_no AND pending
      RETURNING positions INTO folded;
    IF FOUND THEN
      PERFORM search.write_freshness_slot('',NEW.partition_no,coalesce((folded->>NEW.partition_no::text)::bigint,0));
      IF folded='{}'::jsonb THEN DELETE FROM search.freshness_positions WHERE consumer='' AND shard=NEW.partition_no; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION search.group_freshness_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE folded jsonb;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.consumer,OLD.partition_no,OLD.position)=(NEW.consumer,NEW.partition_no,NEW.position) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' AND OLD.position>0 AND starts_with(OLD.consumer,'search_')
     AND (TG_OP='DELETE' OR NEW.position=0 OR (OLD.consumer,OLD.partition_no)<>(NEW.consumer,NEW.partition_no)) THEN
    DELETE FROM search.freshness_positions WHERE consumer=OLD.consumer AND shard=OLD.partition_no;
    PERFORM search.write_freshness_slot(OLD.consumer,OLD.partition_no,0);
  END IF;
  IF TG_OP<>'DELETE' AND starts_with(NEW.consumer,'search_') THEN
    IF NEW.position>0 THEN
      INSERT INTO search.freshness_positions(consumer,shard,positions)
        VALUES (NEW.consumer,NEW.partition_no,jsonb_build_object(NEW.partition_no,NEW.position))
        ON CONFLICT (consumer,shard) DO UPDATE SET positions=EXCLUDED.positions;
      PERFORM search.write_freshness_slot(NEW.consumer,NEW.partition_no,NEW.position);
    END IF;
    UPDATE search.freshness_positions SET pending=false WHERE consumer='' AND shard=NEW.partition_no AND pending
      RETURNING positions INTO folded;
    IF FOUND THEN
      PERFORM search.write_freshness_slot('',NEW.partition_no,coalesce((folded->>NEW.partition_no::text)::bigint,0));
      IF folded='{}'::jsonb THEN DELETE FROM search.freshness_positions WHERE consumer='' AND shard=NEW.partition_no; END IF;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
