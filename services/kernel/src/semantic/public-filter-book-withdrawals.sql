/* semantic.native-keyed:128:192:1 */
-- A TypeList reads only the original's type, own label order and ID. A settled
-- physical withdrawal covers that key for a new PIT. It grants no catalogue ACK.
WITH parent AS MATERIALIZED (
  SELECT * FROM semantic.public_filter_published_coverage(
    :target::text,:incarnation::text,:definition::uuid,NULL,:text_keys::text[])
), pending AS MATERIALIZED (
  SELECT k.input_key FROM parent p JOIN semantic.public_filter_privacy_pending k
    ON k.live AND k.input_key=ANY(p.coverage_keys || :text_keys::text[])
  LIMIT 1
), dirty AS MATERIALIZED (
  SELECT h.* FROM parent p JOIN search.public_filter_coverage_home h
    ON (h.partition_no,h.registration)=(0,p.registration)
  WHERE h.behind ORDER BY h.source_home LIMIT 9
), homes AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch,b.source_position,h.relevant_position
  FROM dirty h JOIN parent p ON h.baseline_bootstrap=p.bootstrap AND h.acknowledged_baseline=p.bootstrap
  JOIN search.public_filter_coverage_baseline b ON
    (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,p.registration,p.bootstrap,h.source_home)
  JOIN core.partition owner ON owner.partition_no=h.source_home AND owner.write_state='active'
    AND owner.epoch=h.source_epoch AND b.source_epoch=owner.epoch
  JOIN semantic.public_filter_privacy_head n ON n.partition_no=owner.partition_no
    AND n.owner_epoch=owner.epoch AND NOT n.population_fenced AND n.position>=h.relevant_position
  WHERE h.acknowledged_position=b.source_position AND h.relevant_position>b.source_position
    AND h.native_enqueue_revision=h.acknowledged_native_enqueue
    AND h.native_revision IS NOT DISTINCT FROM h.acknowledged_native_revision
    AND h.native_claim_revision IS NOT DISTINCT FROM h.acknowledged_native_claim_revision
), budget AS MATERIALIZED (
  SELECT sum(relevant_position-source_position)::integer AS steps FROM homes
  HAVING count(*)=(SELECT count(*) FROM dirty)
    AND sum(relevant_position-source_position) BETWEEN 1 AND 8
), reductions AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch,l.position,s.route,s.subject_id,s.visibility,s.security_revision,b.position AS command_position
  FROM budget CROSS JOIN homes h
  CROSS JOIN LATERAL generate_series(h.source_position+1,least(h.relevant_position,h.source_position+8)) step
  JOIN semantic.public_filter_privacy_log l ON (l.partition_no,l.position,l.owner_epoch)=(h.source_home,step,h.source_epoch)
  JOIN editorial.write_basis b ON (b.partition_no,b.transaction_id,b.epoch)=(l.partition_no,l.transaction_id,l.owner_epoch)
  JOIN core.outbox e ON (e.partition_no,e.position,e.event_seq)=(b.partition_no,b.position,0)
    AND e.epoch=b.epoch AND e.type='com.rezics.subject.visibility_changed.v1' AND e.data->>'id'=e.subject
  JOIN semantic.subject s ON (s.route,s.subject_id)=((l.affected->0->>'route')::integer,(l.affected->0->>'subject')::uuid)
    AND s.route/16=h.source_home AND s.subject_id::text=e.subject AND s.visibility IN ('hidden','taken_down')
    AND s.visibility=e.data->>'visibility' AND s.security_revision::text=e.data->>'security_revision'
  WHERE l.cause='subject' AND l.impacts=l.affected AND l.affected=jsonb_build_array(jsonb_build_object(
    'kind','subject','route',s.route,'subject',s.subject_id))
), visible AS MATERIALIZED (
  -- The writer records source_position only after the exact guarded wait_for
  -- bulk result and physical incarnation check. Compare command positions in
  -- the writer's domain, never the privacy-log sequence or a relay checkpoint.
  SELECT r.* FROM reductions r JOIN search.identity_writer w ON
    (w.partition_no,w.physical_target,w.original_id)=(r.source_home,:target::text,r.subject_id)
  WHERE w.incarnation=:incarnation::text AND w.owner_epoch=r.source_epoch AND w.writer_token IS NULL
    AND w.closed_job IS NULL AND w.dispatch_state='settled' AND w.source_position>=r.command_position
    AND w.visible_transaction_id=w.settled_transaction_id AND w.visible_position=w.settled_position
), captured AS (
  INSERT INTO semantic.public_filter_bootstrap
    (partition_no,bootstrap,read_definition,request_key,consumer,snapshot_kind,native_snapshot,
     owner_epoch,source_position,state,coverage_generation,coverage_publication,book_withdrawals)
  SELECT 0,:bootstrap::uuid,:definition::uuid,:request_key::text||':'||p.job::text||':'||p.generation::text,
    :consumer::text,'pit',pg_current_snapshot(),owner.epoch,owner.position,'begun',p.generation,p.job,
    (SELECT jsonb_agg(jsonb_build_object('home',source_home,'epoch',source_epoch,'position',position::text,
        'route',route,'id',subject_id,'visibility',visibility,'revision',security_revision::text,
        'command',command_position::text)
      ORDER BY source_home,position) FROM visible)
  FROM parent p CROSS JOIN budget JOIN core.partition owner ON owner.partition_no=0
    AND owner.write_state='active' AND owner.epoch=:owner_epoch::integer
  WHERE budget.steps=(SELECT count(*) FROM visible) AND NOT EXISTS(SELECT 1 FROM pending)
    AND NOT EXISTS(SELECT 1 FROM semantic.public_filter_privacy_head WHERE population_fenced)
  ON CONFLICT(partition_no,request_key) WHERE state='begun' AND coverage_publication IS NOT NULL
  DO UPDATE SET request_key=EXCLUDED.request_key RETURNING bootstrap
)
SELECT (SELECT bootstrap::text FROM captured) AS bootstrap,
  EXISTS(SELECT 1 FROM pending WHERE input_key='["scope","subject"]')
    OR EXISTS(SELECT 1 FROM budget WHERE steps=(SELECT count(*) FROM reductions)) AS awaiting;
