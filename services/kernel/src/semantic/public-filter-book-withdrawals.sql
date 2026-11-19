/* semantic.native-keyed:137:210:1 */
-- A TypeList reads only the original's type, own label order and ID. A settled
-- physical withdrawal covers that key for a new PIT. It grants no catalogue ACK.
WITH input AS (
  SELECT :target::text AS target,:incarnation::text AS incarnation,:definition::uuid AS definition,
         :text_keys::text[] AS text_keys
), parent AS MATERIALIZED (
  SELECT proof.* FROM input i
  CROSS JOIN LATERAL semantic.public_filter_published_coverage(
    i.target,i.incarnation,i.definition,NULL,i.text_keys) proof
), members AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset(:members::jsonb) m(bootstrap uuid,definition uuid,request_key text,consumer text)
), pending AS MATERIALIZED (
  SELECT k.input_key FROM parent p CROSS JOIN input i JOIN semantic.public_filter_privacy_pending k
    ON k.live AND k.input_key=ANY(p.coverage_keys || i.text_keys)
  LIMIT 1
), dirty AS MATERIALIZED (
  SELECT h.* FROM parent p JOIN search.public_filter_coverage_home h
    ON (h.partition_no,h.registration)=(0,p.registration)
  WHERE h.behind ORDER BY h.source_home LIMIT 9
), reusable AS MATERIALIZED (
  SELECT prior.book_withdrawals AS withdrawals FROM parent p
  LEFT JOIN LATERAL (
    SELECT cut.book_withdrawals FROM (
      SELECT b.book_withdrawals FROM semantic.public_filter_bootstrap b WHERE b.coverage_publication=p.job
        AND b.coverage_generation=p.generation AND b.book_withdrawals IS NOT NULL LIMIT 1
    ) cut WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(cut.book_withdrawals) w
      LEFT JOIN LATERAL (
        SELECT s.visibility,s.security_revision FROM semantic.subject s
        WHERE (s.route,s.subject_id)=((w->>'route')::integer,(w->>'id')::uuid) LIMIT 1
      ) s ON true
      WHERE s.visibility IS DISTINCT FROM w->>'visibility' OR s.security_revision::text IS DISTINCT FROM w->>'revision')
  ) prior ON true
  WHERE NOT EXISTS (SELECT 1 FROM dirty h WHERE
    semantic.public_filter_book_withdrawal_covers(h::search.public_filter_coverage_home,p.bootstrap,prior.book_withdrawals) IS NOT TRUE)
), homes AS MATERIALIZED (
  SELECT h.source_home,h.source_epoch,b.source_position,h.relevant_position
  FROM dirty h JOIN parent p ON h.baseline_bootstrap=p.bootstrap AND h.acknowledged_baseline=p.bootstrap
  JOIN search.public_filter_coverage_baseline b ON
    (b.partition_no,b.registration,b.bootstrap,b.source_home)=(0,p.registration,p.bootstrap,h.source_home)
  JOIN core.partition owner ON owner.partition_no=h.source_home AND owner.write_state='active'
    AND owner.epoch=h.source_epoch AND b.source_epoch=owner.epoch
  JOIN semantic.public_filter_privacy_head n ON n.partition_no=owner.partition_no
    AND n.owner_epoch=owner.epoch AND NOT n.population_fenced AND n.position>=h.relevant_position
  WHERE NOT EXISTS (SELECT 1 FROM reusable) AND h.acknowledged_position=b.source_position AND h.relevant_position>b.source_position
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
  SELECT r.* FROM reductions r CROSS JOIN input i JOIN search.identity_writer w ON
    (w.partition_no,w.physical_target,w.original_id)=(r.source_home,i.target,r.subject_id)
  WHERE w.incarnation=i.incarnation AND w.owner_epoch=r.source_epoch AND w.writer_token IS NULL
    AND w.closed_job IS NULL AND w.dispatch_state='settled' AND w.source_position>=r.command_position
    AND w.visible_transaction_id=w.settled_transaction_id AND w.visible_position=w.settled_position
), proof AS MATERIALIZED (
  SELECT withdrawals FROM reusable
  UNION ALL
  SELECT (SELECT jsonb_agg(jsonb_build_object('home',source_home,'epoch',source_epoch,'position',position::text,
        'route',route,'id',subject_id,'visibility',visibility,'revision',security_revision::text,
        'command',command_position::text)
      ORDER BY source_home,position) FROM visible) FROM budget WHERE budget.steps=(SELECT count(*) FROM visible)
), captured AS (
  INSERT INTO semantic.public_filter_bootstrap
    (partition_no,bootstrap,read_definition,request_key,consumer,snapshot_kind,native_snapshot,
     owner_epoch,source_position,state,coverage_generation,coverage_publication,book_withdrawals)
  SELECT 0,m.bootstrap,m.definition,m.request_key||':'||p.job::text||':'||p.generation::text,
    m.consumer,'pit',pg_current_snapshot(),owner.epoch,owner.position,'begun',p.generation,p.job,proof.withdrawals
  FROM parent p CROSS JOIN members m CROSS JOIN proof JOIN core.partition owner ON owner.partition_no=0
    AND owner.write_state='active' AND owner.epoch=:owner_epoch::integer
  WHERE NOT EXISTS(SELECT 1 FROM pending)
    AND NOT EXISTS(SELECT 1 FROM semantic.public_filter_privacy_head WHERE population_fenced)
  ORDER BY m.definition
  ON CONFLICT(partition_no,request_key) WHERE state='begun' AND coverage_publication IS NOT NULL
  DO UPDATE SET request_key=EXCLUDED.request_key
  RETURNING bootstrap::text,read_definition::text,consumer,snapshot_kind,owner_epoch,source_position::text,
    state,account_after,queried,publication_job::text,publication_observation,publication_execution,
    coverage_generation::text,coverage_after,coverage_root,coverage_sealed,coverage_publication::text,
    encode(sha256(convert_to(book_withdrawals::text,'UTF8')),'hex') AS withdrawal_digest
)
SELECT m.definition::text,c.bootstrap,to_jsonb(c) AS retained,
  EXISTS(SELECT 1 FROM pending WHERE input_key='["scope","subject"]')
    OR EXISTS(SELECT 1 FROM budget WHERE steps=(SELECT count(*) FROM reductions)) AS awaiting
FROM members m LEFT JOIN captured c ON c.read_definition=m.definition::text;
