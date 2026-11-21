-- migrate:up
-- A first page owns its opening intent before the non-transactional physical open.
-- The bootstrap UUID also determines its one native Search observation key.
CREATE TABLE search.public_filter_pit_claim (
  partition_no integer NOT NULL,
  registration text COLLATE "C" NOT NULL,
  bootstrap uuid NOT NULL,
  deadline bigint NOT NULL,
  target_prefix text COLLATE "C" NOT NULL,
  retry_after bigint NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK (state IN ('new','opening','retained','handed','closing','uncertain')),
  consumer_work text CHECK (octet_length(consumer_work) <= 1048576),
  PRIMARY KEY (partition_no,bootstrap),
  FOREIGN KEY (partition_no,registration) REFERENCES search.public_filter_registration(partition_no,id),
  FOREIGN KEY (partition_no,bootstrap) REFERENCES semantic.public_filter_bootstrap(partition_no,bootstrap)
);
CREATE INDEX public_filter_pit_claim_due ON search.public_filter_pit_claim (target_prefix,retry_after,partition_no,bootstrap) WHERE state<>'uncertain';

-- migrate:down
-- Older writers cannot resume an independent physical opening. Drain active claims first.
LOCK TABLE search.public_filter_pit_claim IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT FROM search.public_filter_pit_claim) THEN
    RAISE EXCEPTION 'Search serving PIT claims still require their native owner';
  END IF;
END
$$;
DROP TABLE search.public_filter_pit_claim;
