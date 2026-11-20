-- migrate:up
-- Readers resolve the immutable interval and its retention clock in their own MVCC
-- snapshot. Ordinary receiver generation and range revision can advance after commit.
CREATE FUNCTION semantic.public_filter_ack_origin(registration_id text, original uuid)
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

-- A point read returns that home's effective receipt. Without a point, seek the
-- appropriate sparse index and return up to nine dirty homes (eight withdrawals
-- plus lookahead). An unreadable cut yields a pending row with no ACK provenance.
CREATE FUNCTION semantic.public_filter_effective_homes(registration_id text, original uuid, point integer DEFAULT NULL,
  home_limit integer DEFAULT 9) RETURNS SETOF search.public_filter_coverage_home
LANGUAGE plpgsql STABLE ROWS 9 SET enable_seqscan = off AS $$
DECLARE
  protocol smallint;
  origin record;
  h search.public_filter_coverage_home%ROWTYPE;
BEGIN
  IF home_limit IS NULL OR home_limit NOT BETWEEN 1 AND 9 OR point NOT BETWEEN 0 AND 4095 THEN
    RAISE EXCEPTION 'Invalid effective ACK home range' USING ERRCODE='22023';
  END IF;
  SELECT c.ack_protocol INTO protocol FROM search.public_filter_coverage_preparation c
    WHERE (c.partition_no,c.registration,c.bootstrap)=(0,registration_id,original);
  IF protocol=0 THEN
    IF point IS NULL THEN
      RETURN QUERY SELECT raw.* FROM search.public_filter_coverage_home raw
        WHERE (raw.partition_no,raw.registration)=(0,registration_id) AND raw.behind
        ORDER BY raw.source_home LIMIT home_limit;
    ELSE
      RETURN QUERY SELECT raw.* FROM search.public_filter_coverage_home raw
        WHERE (raw.partition_no,raw.registration,raw.source_home)=(0,registration_id,point);
    END IF;
    RETURN;
  END IF;
  SELECT * INTO origin FROM semantic.public_filter_ack_origin(registration_id,original) WHERE protocol=1;
  IF NOT FOUND THEN
    h.partition_no := 0;
    h.registration := registration_id;
    h.source_home := point;
    h.behind := true;
    RETURN NEXT h;
    RETURN;
  END IF;

  FOR h IN
    (SELECT raw.* FROM search.public_filter_coverage_home raw WHERE point IS NULL
       AND (raw.partition_no,raw.registration)=(0,registration_id) AND raw.baseline_delta
       ORDER BY raw.source_home LIMIT home_limit)
    UNION ALL
    SELECT raw.* FROM search.public_filter_coverage_home raw WHERE point IS NOT NULL
      AND (raw.partition_no,raw.registration,raw.source_home)=(0,registration_id,point)
  LOOP
    -- The explicit ACK writer currently proves exactly the enrolled tuple. A
    -- newer raw position has no independent covering receipt on this protocol.
    SELECT b.bootstrap,b.source_position,b.native_enqueue_revision,b.native_revision,b.native_claim_revision,
        origin.observation,origin.execution,origin.settlement
      INTO h.acknowledged_baseline,h.acknowledged_position,h.acknowledged_native_enqueue,h.acknowledged_native_revision,
        h.acknowledged_native_claim_revision,h.acknowledged_observation,h.acknowledged_execution,h.acknowledged_settlement
      FROM search.public_filter_coverage_baseline b
      WHERE (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,registration_id,original,h.source_home)
        AND b.source_epoch=h.source_epoch AND h.baseline_bootstrap=original AND h.baseline_delta IS NOT NULL;
    h.behind := NOT FOUND OR h.relevant_position>h.acknowledged_position
      OR h.native_enqueue_revision>h.acknowledged_native_enqueue
      OR h.native_revision IS DISTINCT FROM h.acknowledged_native_revision
      OR h.native_claim_revision IS DISTINCT FROM h.acknowledged_native_claim_revision;
    IF point IS NOT NULL OR h.behind THEN RETURN NEXT h; END IF;
  END LOOP;
END $$;

-- Registration-only clients can still read their materialized v0 receipts.
-- A v1 reader must supply the original bootstrap to select a manifest.
CREATE OR REPLACE FUNCTION semantic.public_filter_book_dirty_homes(registration_id text)
RETURNS SETOF search.public_filter_coverage_home LANGUAGE plpgsql STABLE ROWS 9 SET enable_seqscan = off AS $$
BEGIN
  IF EXISTS (SELECT FROM search.public_filter_coverage_home h JOIN search.public_filter_coverage_preparation c
      ON (c.partition_no,c.registration,c.bootstrap)=(h.partition_no,h.registration,h.baseline_bootstrap)
      WHERE (h.partition_no,h.registration,h.source_home)=(0,registration_id,0) AND c.ack_protocol=1) THEN
    RAISE EXCEPTION 'A manifest ACK requires its original bootstrap' USING ERRCODE='40001';
  END IF;
  RETURN QUERY SELECT h.* FROM search.public_filter_coverage_home h
    WHERE h.partition_no=0 AND h.registration=registration_id AND h.behind ORDER BY h.source_home LIMIT 9;
END $$;

CREATE OR REPLACE FUNCTION semantic.public_filter_published_coverage(physical_target text, incarnation text, child_definition uuid, publication_job uuid, text_keys text[]) RETURNS TABLE(job uuid, bootstrap uuid, registration text, definition uuid, consumer text, generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[])
    LANGUAGE sql STABLE
    AS $_$
WITH candidates AS MATERIALIZED (
  SELECT j.* FROM search.generation_publication j
  WHERE j.partition_no=0 AND j.physical_target=$1 AND j.native_incarnation=$2
    AND j.family='subjects' AND j.phase='active' AND j.fence IS NULL
    AND ($4 IS NULL OR j.job=$4)
  LIMIT 2
)
SELECT j.job,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates j
-- Resolve every immutable publication reference by its unique native key.
-- A physical target, release or partition can host many other registrations and cuts.
JOIN LATERAL (
  SELECT b.* FROM semantic.public_filter_bootstrap b WHERE (b.partition_no,b.publication_job)=(0,j.job) LIMIT 1
) b ON j.bootstrap='0:'||b.bootstrap::text AND j.observation=b.publication_observation
  AND j.execution=b.publication_execution AND b.queried=j.observation AND b.state='adopted'
  AND b.snapshot_kind='prepared' AND b.coverage_sealed AND b.coverage_after=4096 AND b.account_after=4096
JOIN LATERAL (
  SELECT seal.step,seal.complete,seal.ack_after FROM semantic.public_filter_repair_step seal
  WHERE (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,b.publication_execution)
    AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL LIMIT 1
) seal ON seal.complete AND seal.ack_after=4096
JOIN LATERAL (
  SELECT o.* FROM search.public_filter_observation o WHERE (o.partition_no,o.observation)=(0,j.observation) LIMIT 1
) o ON o.consumer_bootstrap=j.bootstrap AND o.prepared_build=j.bootstrap AND o.state='open'
  AND o.expires_at>extract(epoch FROM statement_timestamp())*1000
JOIN LATERAL (
  SELECT r.* FROM search.public_filter_registration r WHERE (r.partition_no,r.id)=(0,o.registration) LIMIT 1
) r ON r.physical_target=j.physical_target AND r.state='active'
JOIN LATERAL (
  SELECT t.incarnation FROM search.public_filter_target t WHERE (t.partition_no,t.physical_target)=(0,r.physical_target) LIMIT 1
) t ON t.incarnation=j.native_incarnation
JOIN LATERAL (
  SELECT d.* FROM semantic.public_filter_read_definition d WHERE (d.partition_no,d.read_definition)=(0,b.read_definition) LIMIT 1
) d ON d.read_definition::text=j.binding->>'readDefinition' AND d.release_digest=j.consumer->>'meaningDigest'
JOIN LATERAL (
  SELECT child.* FROM semantic.public_filter_read_definition child WHERE (child.partition_no,child.read_definition)=(0,$3) LIMIT 1
) child ON (child.source_id,child.configuration,child.release_digest)=(d.source_id,d.configuration,d.release_digest)
  AND child.coverage_keys IS NOT NULL
CROSS JOIN LATERAL (
  SELECT s.owner_epoch FROM semantic.public_filter_source s
  WHERE (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration) LIMIT 1
) s
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN LATERAL (
  SELECT c.* FROM search.public_filter_coverage_preparation c
  WHERE (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap) LIMIT 1
) c ON c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN LATERAL (
  SELECT last_home.root FROM search.public_filter_coverage_baseline last_home
  WHERE (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095) LIMIT 1
) last_home ON last_home.root=c.root
WHERE (SELECT count(*) FROM candidates)=1
  AND (c.ack_protocol=0 OR EXISTS (
    SELECT FROM semantic.public_filter_ack_origin(r.id,b.bootstrap) m
    WHERE (m.job,m.observation,m.execution,m.terminal,m.ack_after)=(j.job,j.observation,j.execution,seal.step,4096)
  ))
  AND '["scope","catalogue-text"]'=ANY(d.coverage_keys)
  AND child.coverage_keys <@ (d.coverage_keys || $5)
$_$;

CREATE OR REPLACE FUNCTION semantic.public_filter_mixed_coverage(physical_target text, incarnation text, child_definition uuid, parent_bootstrap uuid, encoded_consumer text) RETURNS TABLE(job uuid, bootstrap uuid, registration text, definition uuid, consumer text, generation bigint, covered_generation bigint, coverage_root text, coverage_keys text[])
    LANGUAGE sql STABLE
    AS $_$
WITH child AS MATERIALIZED (
  SELECT d.*,semantic.public_filter_mixed_page_scope(d.capture) AS scope
  FROM semantic.public_filter_read_definition d
  WHERE (d.partition_no,d.read_definition)=(0,$3) AND '["domain","accounts"]'=ANY(d.coverage_keys)
), candidates AS MATERIALIZED (
  SELECT child.read_definition,$5 AS consumer FROM child WHERE $4 IS NULL
  UNION ALL
  SELECT compatible.read_definition,semantic.public_filter_mixed_consumer_for_definition($5,$3,compatible.read_definition)
  FROM child CROSS JOIN LATERAL (
    SELECT d.read_definition FROM semantic.public_filter_read_definition d
    WHERE (d.partition_no,d.source_id,d.configuration,d.release_digest)=
        (child.partition_no,child.source_id,child.configuration,child.release_digest)
      AND d.read_definition<>child.read_definition AND '["domain","accounts"]'=ANY(d.coverage_keys)
      AND d.coverage_keys=child.coverage_keys AND d.dependency_keys=child.dependency_keys
      AND md5(semantic.public_filter_mixed_page_scope(d.capture)::text)=md5(child.scope::text)
      AND semantic.public_filter_mixed_page_scope(d.capture)=child.scope
    ORDER BY d.read_definition LIMIT 4
  ) compatible WHERE $4 IS NULL
  UNION ALL
  SELECT d.read_definition,CASE WHEN d.read_definition=$3 THEN $5
    ELSE semantic.public_filter_mixed_consumer_for_definition($5,$3,d.read_definition) END
  FROM child JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,$4)
  JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(b.partition_no,b.read_definition)
  WHERE (d.source_id,d.configuration,d.release_digest)=(child.source_id,child.configuration,child.release_digest)
    AND d.coverage_keys=child.coverage_keys AND d.dependency_keys=child.dependency_keys
    AND (d.read_definition=$3 OR semantic.public_filter_mixed_page_scope(d.capture)=child.scope)
)
SELECT b.bootstrap,b.bootstrap,r.id,d.read_definition,r.consumer,r.coverage_generation,b.coverage_generation,
       b.coverage_root,d.coverage_keys
FROM candidates candidate
JOIN search.public_filter_registration r ON r.partition_no=0 AND r.physical_target=$1 AND r.state='active'
  AND md5(r.consumer)=md5(candidate.consumer) AND r.consumer=candidate.consumer
JOIN search.public_filter_target t ON (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target)
  AND t.incarnation=$2
JOIN search.discovery_generation g ON g.partition_no=0 AND g.state='active'
  AND g.prefix=regexp_replace(r.physical_target,'discovery-g[1-9][0-9]*$','')
  AND g.prefix||'discovery-g'||g.generation::text=r.physical_target AND g.index_uuid=t.incarnation
  AND g.capability->>'physicalTarget'=r.physical_target AND g.capability->>'uuid'=t.incarnation
  AND g.capability->>'incarnation'=g.incarnation::text
JOIN search.public_filter_coverage_home h ON (h.partition_no,h.registration,h.source_home)=(0,r.id,0)
  AND h.acknowledged_baseline=h.baseline_bootstrap AND NOT h.behind
JOIN semantic.public_filter_bootstrap b ON (b.partition_no,b.bootstrap)=(0,h.baseline_bootstrap)
  AND b.state='adopted' AND b.coverage_publication IS NULL AND b.publication_job IS NULL
  AND b.account_after=4096 AND b.coverage_after=4096 AND b.coverage_sealed
  AND b.queried=h.acknowledged_observation AND ($4 IS NULL OR b.bootstrap=$4)
JOIN search.public_filter_observation o ON (o.partition_no,o.observation)=(0,b.queried)
  AND o.registration=r.id AND o.consumer_bootstrap='0:'||b.bootstrap::text
  AND o.state='open'
JOIN search.public_filter_execution e ON (e.partition_no,e.observation,e.id)=(0,o.observation,h.acknowledged_execution)
  AND e.repair_settlement IS NOT NULL
JOIN LATERAL (SELECT semantic.public_filter_native_json(e.repair_settlement::jsonb) AS evidence) settled
  ON settled.evidence->>'id'=h.acknowledged_settlement AND settled.evidence->>'execution'=e.id
  AND settled.evidence->>'bootstrap'=o.consumer_bootstrap AND settled.evidence->>'closed'='true'
  AND settled.evidence->'fence'->>'incarnation'=t.incarnation
  AND settled.evidence->'fence'->>'sourceEpoch'=b.owner_epoch::text
  AND settled.evidence->'fence'->>'writeAlias'=r.physical_target||'-write'
JOIN semantic.public_filter_repair_step seal ON (seal.partition_no,seal.bootstrap,seal.execution)=(0,b.bootstrap,e.id)
  AND seal.verified_root IS NOT NULL AND seal.verified_next IS NULL AND seal.complete AND seal.ack_after=4096
JOIN semantic.public_filter_read_definition d ON (d.partition_no,d.read_definition)=(0,b.read_definition)
  AND d.read_definition=candidate.read_definition AND '["domain","accounts"]'=ANY(d.coverage_keys)
JOIN semantic.public_filter_source s ON (s.partition_no,s.source_id,s.configuration)=(0,d.source_id,d.configuration)
JOIN core.partition p ON p.partition_no=0 AND p.epoch=b.owner_epoch AND s.owner_epoch=p.epoch AND p.write_state='active'
JOIN search.public_filter_coverage_preparation c ON (c.partition_no,c.registration,c.bootstrap)=(0,r.id,b.bootstrap)
  AND c.ack_protocol=0 AND c.population_protocol=1 AND c.after_home=4096 AND c.generation=b.coverage_generation
  AND c.root=b.coverage_root AND c.definition=d.read_definition AND c.consumer=r.consumer
JOIN search.public_filter_coverage_baseline last_home ON
  (last_home.partition_no,last_home.registration,last_home.bootstrap,last_home.source_home)=(0,r.id,b.bootstrap,4095)
  AND last_home.root=c.root
WHERE r.physical_target ~ 'discovery-g[1-9][0-9]*$'
ORDER BY (d.read_definition=$3) DESC,b.bootstrap LIMIT 1
$_$;

-- migrate:down
DO $$ BEGIN RAISE EXCEPTION 'Effective receiver ACK readers require forward migration'; END $$;
