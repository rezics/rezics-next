-- Exact page locators in one source home. Projection rows are never statement authority.
WITH input AS NOT MATERIALIZED (
 SELECT :partition_no::integer AS home, :context_id::uuid AS context,
        :defaults::jsonb AS defaults, :viewer_account::uuid AS account, :viewer_moderator::boolean AS moderator
)
SELECT wanted.id::text AS subject, wanted.property, wanted.candidate::text AS candidate,
       live.body, live.release, live.revision, origin.source
FROM jsonb_to_recordset(:entries::jsonb) wanted(route integer, id uuid, property text, candidate uuid)
CROSS JOIN input
JOIN LATERAL (
 SELECT type FROM semantic.subject WHERE route=wanted.route AND subject_id=wanted.id AND visibility='visible'
   AND route>=input.home*16 AND route<(input.home+1)*16 LIMIT 1
) subject ON true
LEFT JOIN LATERAL (
 SELECT target FROM semantic.redirect WHERE route=wanted.route AND subject_id=wanted.id
   AND route>=input.home*16 AND route<(input.home+1)*16 ORDER BY sequence DESC LIMIT 1
) redirect ON true
JOIN LATERAL (
 SELECT slot_id FROM semantic.candidate WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate AND property=wanted.property
   AND route>=input.home*16 AND route<(input.home+1)*16
 UNION ALL
 SELECT slot_id FROM semantic.fact WHERE route=wanted.route AND subject_id=wanted.id AND statement_id=wanted.candidate
   AND kind='statement' AND property=wanted.property AND operation='assert'
   AND route>=input.home*16 AND route<(input.home+1)*16
 LIMIT 1
) locator ON true
JOIN LATERAL (
 SELECT operation FROM semantic.fact WHERE route=wanted.route AND subject_id=wanted.id AND slot_id=locator.slot_id
   AND route>=input.home*16 AND route<(input.home+1)*16 ORDER BY log_seq DESC LIMIT 1
) head ON true
LEFT JOIN LATERAL (
 SELECT mode, selection FROM semantic.adoption WHERE route=wanted.route AND subject_id=wanted.id AND slot_id=locator.slot_id
   AND context_id=input.context AND head.operation='expand'
   AND route>=input.home*16 AND route<(input.home+1)*16 ORDER BY head DESC LIMIT 1
) local_adoption ON true
LEFT JOIN LATERAL (
 SELECT mode, selection FROM semantic.adoption WHERE route=wanted.route AND subject_id=wanted.id AND slot_id=locator.slot_id
   AND context_id='00000000-0000-8000-8000-000000000000' AND head.operation='expand'
   AND route>=input.home*16 AND route<(input.home+1)*16 ORDER BY head DESC LIMIT 1
) global_adoption ON true
JOIN LATERAL (
 SELECT compact.body, r.release, r.revision FROM (
   SELECT body, operation, recorded_transaction_id FROM semantic.fact
   WHERE route=wanted.route AND subject_id=wanted.id AND slot_id=locator.slot_id AND statement_id=wanted.candidate
       AND statement_id IS NOT NULL AND kind='statement'
     AND head.operation<>'expand' AND route>=input.home*16 AND route<(input.home+1)*16
   ORDER BY log_seq DESC LIMIT 1
 ) compact
 JOIN LATERAL (
   SELECT release,revision FROM semantic.revision WHERE route=wanted.route AND subject_id=wanted.id
     AND recorded_transaction_id=compact.recorded_transaction_id
     AND route>=input.home*16 AND route<(input.home+1)*16 LIMIT 1
 ) r ON true WHERE compact.operation='assert'
 UNION ALL
 SELECT c.statement || jsonb_build_object('rank', selected.entry->>'rank'), c.release,c.revision
 FROM jsonb_array_elements(CASE WHEN local_adoption.mode='replace' THEN local_adoption.selection
   ELSE global_adoption.selection END) selected(entry)
 JOIN LATERAL (
   SELECT statement,release,revision FROM semantic.candidate WHERE route=wanted.route AND subject_id=wanted.id
     AND candidate_id=wanted.candidate AND candidate_id=(selected.entry->>'candidate')::uuid
     AND route>=input.home*16 AND route<(input.home+1)*16 LIMIT 1
 ) c ON true
 WHERE head.operation='expand' AND COALESCE(local_adoption.mode,'inherit')<>'suppress'
   AND (local_adoption.mode='replace' OR global_adoption.mode='replace')
) live ON true
JOIN LATERAL (
 SELECT source FROM semantic.revision WHERE route=wanted.route AND subject_id=wanted.id AND revision=live.revision
   AND route>=input.home*16 AND route<(input.home+1)*16 LIMIT 1
) origin ON true
WHERE redirect.target IS NULL AND COALESCE(live.body->>'rank','normal')<>'deprecated'
 AND (input.context='00000000-0000-8000-8000-000000000000' OR local_adoption.mode='replace'
   OR head.operation='expand' AND local_adoption.mode='inherit'
   OR COALESCE(input.defaults->>wanted.property,'inherit')<>'suppress')
 AND NOT EXISTS (
   SELECT 1 FROM semantic.acceptance_current WHERE route=wanted.route AND subject_id=wanted.id
     AND candidate_id=wanted.candidate AND context_id=input.context AND verdict='reject'
     AND head.operation='expand' AND input.context<>'00000000-0000-8000-8000-000000000000' AND COALESCE(local_adoption.mode,'inherit')='inherit'
     AND route>=input.home*16 AND route<(input.home+1)*16
 )
 AND NOT EXISTS (
   SELECT 1 FROM semantic.hidden_candidate WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate
     AND route>=input.home*16 AND route<(input.home+1)*16
   UNION ALL
   SELECT 1 FROM semantic.record_lifecycle WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate
     AND state IN ('deleted','purging','purged') AND route>=input.home*16 AND route<(input.home+1)*16
   UNION ALL
   SELECT 1 FROM semantic.statement_disclosure d WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate
     AND route>=input.home*16 AND route<(input.home+1)*16
     AND (NOT d.disclosed AND NOT (input.moderator OR d.account_id=input.account) OR EXISTS (
       SELECT 1 FROM semantic.retraction WHERE route=wanted.route AND subject_id=wanted.id AND candidate_id=wanted.candidate
         AND route>=input.home*16 AND route<(input.home+1)*16
     ))
 );
