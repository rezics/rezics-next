-- migrate:up
-- Interrupted and invalid installation still require topology work, but remaining tracks
-- actual unclosed homes so bounded batches can finish instead of replaying a hardcoded 4096.
CREATE OR REPLACE FUNCTION semantic.identity_epoch_bootstrap_remaining() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN (i.mode IS NOT NULL AND NOT i.valid)
      OR (i.mode IS NULL AND EXISTS (
        SELECT 1 FROM semantic.identity_epoch_installation_cut WHERE partition_no=0))
    THEN (SELECT count(*)::integer FROM semantic.identity_epoch_bootstrap_topology_home
          WHERE partition_no=0 AND NOT closed)
    WHEN i.mode='absence' AND i.valid THEN 0
    ELSE t.remaining END
  FROM semantic.identity_epoch_bootstrap_topology t
  LEFT JOIN semantic.read_identity_epoch_installation() i ON true
  WHERE t.partition_no=0;
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.identity_epoch_bootstrap_remaining() RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN (i.mode IS NOT NULL AND NOT i.valid)
      OR (i.mode IS NULL AND EXISTS (
        SELECT 1 FROM semantic.identity_epoch_installation_cut WHERE partition_no=0)) THEN 4096
    WHEN i.mode='absence' AND i.valid THEN 0 ELSE t.remaining END
  FROM semantic.identity_epoch_bootstrap_topology t
  LEFT JOIN semantic.read_identity_epoch_installation() i ON true WHERE t.partition_no=0;
$$;
