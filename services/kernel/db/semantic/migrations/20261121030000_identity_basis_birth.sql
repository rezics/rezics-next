-- migrate:up
-- Only a new revision-1 Subject introduces self identity without changing an
-- existing original. A restored, bootstrapped or split singleton is structural.
CREATE FUNCTION semantic.identity_basis_birth(g semantic.identity_epoch_group) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT g.version=1 AND g.published_epoch=1 AND g.ready AND g.observed_count=1
    AND g.pending_job IS NULL AND g.pending_epoch IS NULL
    AND g.closure_state='open' AND g.closure_claim IS NULL AND g.closure_after IS NULL
    AND g.closure_close_transaction IS NULL AND g.closure_seal_transaction IS NULL AND NOT g.closure_cleanup_complete
    AND EXISTS (
      SELECT 1 FROM semantic.subject s
      JOIN semantic.revision r ON (r.route,r.subject_id,r.revision)=(s.route,s.subject_id,1)
      JOIN semantic.identity_epoch_mapping m ON (m.route,m.original)=(s.route,s.subject_id)
      JOIN semantic.identity_epoch_home_gate h ON (h.route,h.destination,h.original)=(s.route,s.subject_id,s.subject_id)
      JOIN semantic.identity_epoch_original o ON (o.partition_no,o.generation,o.original)=(g.partition_no,g.generation,s.subject_id)
      JOIN core.partition p ON p.partition_no=g.partition_no
      WHERE s.route=get_byte(uuid_send(g.terminal),10)*256+get_byte(uuid_send(g.terminal),11)
        AND s.subject_id=g.terminal AND s.route/16=g.partition_no
        AND p.write_state='active' AND p.epoch=g.owner_epoch AND m.owner_epoch=p.epoch
        AND s.xmin=pg_current_xact_id()::xid AND r.xmin=s.xmin AND m.xmin=s.xmin AND h.xmin=s.xmin AND o.xmin=s.xmin
        AND r.kind='create' AND r.recorded_transaction_id=s.recorded_transaction_id
        AND m.recorded_transaction_id=r.recorded_transaction_id AND h.recorded_transaction_id=r.recorded_transaction_id
        AND m.origin='creation' AND m.terminal=g.terminal AND m.control_group=g.terminal AND m.control_partition=p.partition_no
        AND m.epoch=g.published_epoch AND h.terminal=g.terminal AND h.epoch=m.epoch
        AND h.pending_job IS NULL AND h.pending_epoch IS NULL
        AND o.present AND o.terminal=g.terminal AND o.source_partition=p.partition_no AND o.source_generation=0
        AND o.closure_state='legacy' AND m.closure_state='legacy'
        AND NOT EXISTS (SELECT 1 FROM semantic.identity_epoch_original peer
          WHERE peer.partition_no=g.partition_no AND peer.generation=g.generation AND peer.original<>g.terminal)
        AND NOT EXISTS (SELECT 1 FROM semantic.revision later
          WHERE later.route=s.route AND later.subject_id=s.subject_id AND later.revision>1)
        AND NOT EXISTS (SELECT 1 FROM semantic.redirect d WHERE (d.route,d.subject_id)=(s.route,s.subject_id))
    );
$$;

CREATE OR REPLACE TRIGGER identity_basis_group AFTER UPDATE OR DELETE ON semantic.identity_epoch_group
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_effect();
CREATE TRIGGER identity_basis_group_insert AFTER INSERT ON semantic.identity_epoch_group
  FOR EACH ROW WHEN (NOT semantic.identity_basis_birth(NEW)) EXECUTE FUNCTION semantic.capture_identity_basis_effect();
ALTER TABLE semantic.identity_epoch_group ENABLE ALWAYS TRIGGER identity_basis_group;
ALTER TABLE semantic.identity_epoch_group ENABLE ALWAYS TRIGGER identity_basis_group_insert;

-- migrate:down
DROP TRIGGER identity_basis_group_insert ON semantic.identity_epoch_group;
CREATE OR REPLACE TRIGGER identity_basis_group AFTER INSERT OR DELETE OR UPDATE ON semantic.identity_epoch_group
  FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_basis_effect();
ALTER TABLE semantic.identity_epoch_group ENABLE ALWAYS TRIGGER identity_basis_group;
DROP FUNCTION semantic.identity_basis_birth(semantic.identity_epoch_group);
