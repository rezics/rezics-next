-- migrate:up
CREATE OR REPLACE FUNCTION semantic.public_filter_ack_origin(registration_id text, original uuid)
RETURNS TABLE(job uuid,observation text,execution text,settlement text,terminal uuid,ack_after integer)
LANGUAGE sql STABLE ROWS 1 AS $$
  -- Each equality group verifies one witness against the retained manifest. Keep the
  -- lookups separate so planning does not enumerate joins across independent proofs.
  SELECT m.job,m.observation,m.execution,m.settlement,m.terminal,t.ack_after
  FROM search.public_filter_ack_manifest m
  JOIN LATERAL (
    SELECT a.repair_settlement FROM search.public_filter_ack_authority a
    WHERE (a.partition_no,a.job,a.registration,a.bootstrap,a.observation,a.execution,a.physical_target,a.incarnation,
     a.owner_epoch,a.generation,a.enrollment_root,a.identity_digest)=
    (m.partition_no,m.job,m.registration,m.bootstrap,m.observation,m.execution,m.physical_target,m.incarnation,
     m.owner_epoch,m.generation,m.enrollment_root,m.identity_digest)
    OFFSET 0
  ) a ON true
  JOIN LATERAL (
    SELECT 1 FROM search.public_filter_repair_verification v
    WHERE (v.partition_no,v.observation,v.execution,v.evidence_revision)=
    (m.partition_no,m.observation,m.execution,m.evidence_revision)
    OFFSET 0
  ) v ON true
  JOIN LATERAL (
    SELECT 1 FROM search.public_filter_ack_range r
    WHERE (r.revision,r.digest,r.job,r.partition_no,r.registration,r.bootstrap,r.binding,r.identity_digest,
     r.first_home,r.width,r.enrollment_root)=
    (m.root_revision,m.root_digest,m.job,m.partition_no,m.registration,m.bootstrap,m.binding,m.identity_digest,
     0,4096,m.enrollment_root)
    OFFSET 0
  ) r ON true
  JOIN LATERAL (
    SELECT t.ack_after,t.complete,t.verified_next FROM semantic.public_filter_repair_step t
    WHERE (t.partition_no,t.bootstrap,t.execution,t.step,t.verified_binding,t.verified_root,t.verified_ordinal)=
    (m.partition_no,m.bootstrap,m.execution,m.terminal,m.binding,m.terminal_root,m.ordinal)
    OFFSET 0
  ) t ON true
  JOIN LATERAL (
    SELECT k.incarnation,k.continuity FROM search.public_filter_ack_home_clock k
    WHERE (k.partition_no,k.registration,k.bootstrap,k.first_home,k.width)=(m.partition_no,m.registration,m.bootstrap,0,4096)
    OFFSET 0
  ) k ON true
  WHERE (m.partition_no,m.registration,m.bootstrap)=(0,registration_id,original)
    AND m.version=1 AND m.committed_by IS DISTINCT FROM pg_current_xact_id_if_assigned()
    AND t.complete AND t.verified_next IS NULL
    AND search.public_filter_ack_settlement_digest(a.repair_settlement::jsonb->1)=m.settlement_digest
    AND m.continuity=(SELECT sha256(uuid_send(k.incarnation)||int8send(k.continuity)||
      sha256(convert_to(jsonb_agg(jsonb_build_array(w.physical_target,w.lane,w.revision)
        ORDER BY w.physical_target,w.lane)::text,'UTF8')))
      FROM search.public_filter_repair_authority w WHERE w.physical_target IN ('','@ack-retention') HAVING count(*)=8)
$$;

-- migrate:down
CREATE OR REPLACE FUNCTION semantic.public_filter_ack_origin(registration_id text, original uuid)
RETURNS TABLE(job uuid,observation text,execution text,settlement text,terminal uuid,ack_after integer)
LANGUAGE sql STABLE ROWS 1 AS $$
  SELECT m.job,m.observation,m.execution,m.settlement,m.terminal,t.ack_after
  FROM search.public_filter_ack_manifest m
  JOIN search.public_filter_ack_authority a ON
    (a.partition_no,a.job,a.registration,a.bootstrap,a.observation,a.execution,a.physical_target,a.incarnation,
     a.owner_epoch,a.generation,a.enrollment_root,a.identity_digest)=
    (m.partition_no,m.job,m.registration,m.bootstrap,m.observation,m.execution,m.physical_target,m.incarnation,
     m.owner_epoch,m.generation,m.enrollment_root,m.identity_digest)
  JOIN search.public_filter_repair_verification v ON (v.partition_no,v.observation,v.execution,v.evidence_revision)=
    (m.partition_no,m.observation,m.execution,m.evidence_revision)
  JOIN search.public_filter_ack_range r ON
    (r.revision,r.digest,r.job,r.partition_no,r.registration,r.bootstrap,r.binding,r.identity_digest,
     r.first_home,r.width,r.enrollment_root)=
    (m.root_revision,m.root_digest,m.job,m.partition_no,m.registration,m.bootstrap,m.binding,m.identity_digest,
     0,4096,m.enrollment_root)
  JOIN semantic.public_filter_repair_step t ON
    (t.partition_no,t.bootstrap,t.execution,t.step,t.verified_binding,t.verified_root,t.verified_ordinal)=
    (m.partition_no,m.bootstrap,m.execution,m.terminal,m.binding,m.terminal_root,m.ordinal)
  JOIN search.public_filter_ack_home_clock k ON
    (k.partition_no,k.registration,k.bootstrap,k.first_home,k.width)=(m.partition_no,m.registration,m.bootstrap,0,4096)
  WHERE (m.partition_no,m.registration,m.bootstrap)=(0,registration_id,original)
    AND m.version=1 AND m.committed_by IS DISTINCT FROM pg_current_xact_id_if_assigned()
    AND t.complete AND t.verified_next IS NULL
    AND search.public_filter_ack_settlement_digest(a.repair_settlement::jsonb->1)=m.settlement_digest
    AND m.continuity=(SELECT sha256(uuid_send(k.incarnation)||int8send(k.continuity)||
      sha256(convert_to(jsonb_agg(jsonb_build_array(w.physical_target,w.lane,w.revision)
        ORDER BY w.physical_target,w.lane)::text,'UTF8')))
      FROM search.public_filter_repair_authority w WHERE w.physical_target IN ('','@ack-retention') HAVING count(*)=8)
$$;
