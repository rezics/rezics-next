-- migrate:up
-- Keep the ordered witness encoding used by existing Discovery generations.
-- Each segment is derived from its current native row in the writer's transaction.
ALTER TABLE community.space_discovery_dependency_install
  ADD COLUMN install_witness_segment text GENERATED ALWAYS AS (
    partition_no::text||':'||cursor_route::text||':'||cursor_id::text||':'||
    cut_route::text||':'||cut_id::text||':'||complete::text
  ) STORED NOT NULL;

ALTER TABLE community.space_discovery_tuple_capability
  ADD COLUMN generation_witness_segment text GENERATED ALWAYS AS (
    partition_no::text||':'||generation::text
  ) STORED NOT NULL,
  ADD COLUMN cut_witness_segment text GENERATED ALWAYS AS (
    partition_no::text||':'||cut::text||':'||required::text||':'||witnessed::text||':'||pending::text
  ) STORED NOT NULL;

-- migrate:down
ALTER TABLE community.space_discovery_tuple_capability
  DROP COLUMN cut_witness_segment,
  DROP COLUMN generation_witness_segment;
ALTER TABLE community.space_discovery_dependency_install
  DROP COLUMN install_witness_segment;
