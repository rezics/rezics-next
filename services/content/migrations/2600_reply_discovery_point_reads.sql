-- Public discovery hydrates exact identities. Pin the point plans at their
-- owner so generic batch estimates cannot turn them into inventory hash joins.
CREATE FUNCTION content.discovery_reply(resource text)
RETURNS SETOF content.reply
LANGUAGE sql STABLE ROWS 1
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.reply WHERE id=resource LIMIT 1;
$$;
CREATE FUNCTION content.discovery_variant(resource text)
RETURNS SETOF content.variant
LANGUAGE sql STABLE ROWS 1
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.variant WHERE id=resource LIMIT 1;
$$;
CREATE FUNCTION content.discovery_revision(resource uuid)
RETURNS SETOF content.revision
LANGUAGE sql STABLE ROWS 1
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.revision WHERE id=resource LIMIT 1;
$$;
CREATE FUNCTION content.discovery_receipt(operation text)
RETURNS SETOF content.receipt
LANGUAGE sql STABLE ROWS 1
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.receipt WHERE operation_id=operation LIMIT 1;
$$;

CREATE FUNCTION content.discovery_placement(operation text)
RETURNS SETOF content.realm_placement_preparation
LANGUAGE sql STABLE ROWS 1
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.realm_placement_preparation WHERE operation_id=operation LIMIT 1;
$$;

-- Each requested parent owns its indexed child range. The global walk still
-- stops at the existing count bound; unrelated roots never enter that walk.
CREATE FUNCTION content.discovery_children(parent text, bound integer)
RETURNS SETOF content.reply
LANGUAGE sql STABLE ROWS 64
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT * FROM content.reply WHERE parent_reply=parent
    ORDER BY created_at,id LIMIT bound;
$$;

CREATE FUNCTION content.discovery_exact_revisions(ids uuid[])
RETURNS SETOF content.revision
LANGUAGE sql STABLE ROWS 64
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT r.* FROM unnest(ids) requested(id)
    CROSS JOIN LATERAL (SELECT * FROM content.revision WHERE id=requested.id LIMIT 1) r;
$$;

-- Keep anti-existence probes correlated to the selected identity. PostgreSQL
-- can otherwise build a hashed subplan of every origin/review before probing.
CREATE FUNCTION content.discovery_review_live(resource text, target_realm text, decision uuid)
RETURNS boolean LANGUAGE sql STABLE
SET enable_seqscan=off SET enable_bitmapscan=off SET jit=off AS $$
  SELECT NOT EXISTS(SELECT 1 FROM content.reply_author origin
    WHERE origin.reply=resource AND origin.origin_realm IS NOT NULL AND origin.origin_realm<>target_realm)
    AND NOT EXISTS(SELECT 1 FROM content.realm_review_decision later WHERE later.supersedes=decision);
$$;

CREATE FUNCTION content.discovery_current_reviews(heads jsonb, evidence boolean)
RETURNS TABLE(ordinal integer,realm text,reply text,revision text,review text,preparation text,
  origin text,author text,root text,root_revision text,variant text,revision_digest text,
  data_epoch text,sequence text,created_at timestamptz)
LANGUAGE sql STABLE ROWS 64
SET enable_seqscan=off SET enable_bitmapscan=off SET enable_hashjoin=off SET enable_mergejoin=off SET jit=off AS $$
  SELECT x.ordinal,d.realm,p.id,d.revision_id::text,d.id::text,prepared.operation_id,
    p.origin_realm,p.author,p.root_target,p.root_revision,p.variant_id,r.byte_digest,
    receipt.data_epoch::text,receipt.sequence::text,p.created_at
  FROM jsonb_to_recordset(heads) AS x(ordinal int,reply text,realm text,revision text,review text,preparation text)
  CROSS JOIN LATERAL (SELECT * FROM content.reply WHERE id=x.reply LIMIT 1) p
  CROSS JOIN LATERAL (SELECT * FROM content.variant WHERE id=p.variant_id LIMIT 1) v
  CROSS JOIN LATERAL content.discovery_revision(v.draft_head) head

  CROSS JOIN LATERAL (SELECT * FROM content.realm_review_decision candidate WHERE candidate.variant_id=p.variant_id
    AND candidate.realm=x.realm AND candidate.revision_id=x.revision::uuid AND candidate.outcome='approved'
    AND (x.review IS NULL OR candidate.id=x.review::uuid) OFFSET 0) d
  CROSS JOIN LATERAL content.discovery_revision(d.revision_id) r
  LEFT JOIN LATERAL content.discovery_placement(x.preparation) prepared ON evidence
  LEFT JOIN LATERAL content.discovery_receipt(prepared.operation_id) receipt ON evidence
    AND receipt.action='publication.prepare' AND receipt.outcome='succeeded'
    AND receipt.variant_id=prepared.variant_id AND receipt.revision_id=prepared.revision_id
  WHERE head.availability='available' AND head.body->>'deleted'='false'
  AND r.variant_id=d.variant_id AND r.availability='available'
  AND content.discovery_review_live(p.id,x.realm,d.id)
  AND (x.preparation IS NULL OR EXISTS (
    SELECT 1 FROM content.realm_placement_preparation placement
    JOIN content.publication_preparation publication ON publication.operation_id=placement.operation_id
    WHERE placement.operation_id=x.preparation AND placement.realm=d.realm
      AND placement.variant_id=p.variant_id AND placement.revision_id=d.revision_id
      AND placement.review_decision_id=d.id AND publication.status='active' AND publication.pin_active))
  AND (NOT evidence OR receipt.operation_id IS NOT NULL)
  ORDER BY x.ordinal;
$$;
