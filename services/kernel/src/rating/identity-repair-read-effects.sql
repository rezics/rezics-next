SELECT position::text AS position,
       event_seq::text AS "eventSeq",
       id,
       type,
       subject,
       data,
       recorded_at::text AS time
FROM core.outbox
WHERE subject = $1::text
  AND type IN (
    'com.rezics.rating.vote.changed.v1',
    'com.rezics.rating.identity-repair.page.v1',
    'com.rezics.rating.identity-work.changed.v1'
  )
ORDER BY position, event_seq;
