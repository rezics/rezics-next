WITH input AS (
  SELECT
    :route::integer AS route,
    :account_id::uuid AS account_id,
    :stage::text AS stage,
    :notice_after_created_at::nullable(timestamptz) AS notice_after_created_at,
    :notice_after_id::nullable(uuid) AS notice_after_id,
    :finalization_after_created_at::nullable(timestamptz) AS finalization_after_created_at,
    :finalization_after_kind::nullable(text) AS finalization_after_kind,
    :finalization_after_id::nullable(uuid) AS finalization_after_id
), notice_page AS MATERIALIZED (
  SELECT notice.ctid, notice.created_at, notice.notice_id
  FROM content.notice AS notice
  CROSS JOIN input
  WHERE input.stage = 'notices'
    AND notice.route = input.route
    AND notice.recipient_id = input.account_id
    AND (
      input.notice_after_created_at IS NULL
      OR (notice.created_at, notice.notice_id) < (input.notice_after_created_at, input.notice_after_id)
    )
  ORDER BY notice.created_at DESC, notice.notice_id DESC
  LIMIT 50
  FOR UPDATE
), deleted_notice AS (
  DELETE FROM content.notice AS notice
  USING notice_page AS page
  WHERE notice.ctid = page.ctid
  RETURNING notice.ctid, notice.created_at, notice.notice_id
), notice_remaining AS (
  SELECT EXISTS (
    SELECT 1
    FROM content.notice AS notice
    CROSS JOIN input
    WHERE notice.route = input.route
      AND notice.recipient_id = input.account_id
      AND NOT EXISTS (SELECT 1 FROM deleted_notice AS deleted WHERE deleted.ctid = notice.ctid)
  ) AS present
), finalization_page AS MATERIALIZED (
  SELECT finalization.ctid, finalization.created_at, finalization.kind, finalization.source_id
  FROM content.notice_finalization AS finalization
  CROSS JOIN input
  WHERE input.stage = 'finalizations'
    AND finalization.route = input.route
    AND finalization.recipient_id = input.account_id
    AND (
      input.finalization_after_created_at IS NULL
      OR (finalization.created_at, finalization.kind, finalization.source_id) >
        (input.finalization_after_created_at, input.finalization_after_kind, input.finalization_after_id)
    )
  ORDER BY finalization.created_at, finalization.kind, finalization.source_id
  LIMIT 50
  FOR UPDATE
), deleted_finalization AS (
  DELETE FROM content.notice_finalization AS finalization
  USING finalization_page AS page
  WHERE finalization.ctid = page.ctid
  RETURNING finalization.ctid, finalization.created_at, finalization.kind, finalization.source_id
), finalization_remaining AS (
  SELECT EXISTS (
    SELECT 1
    FROM content.notice_finalization AS finalization
    CROSS JOIN input
    WHERE finalization.route = input.route
      AND finalization.recipient_id = input.account_id
      AND NOT EXISTS (SELECT 1 FROM deleted_finalization AS deleted WHERE deleted.ctid = finalization.ctid)
  ) AS present
), deleted_seen AS (
  DELETE FROM content.notice_seen AS seen
  USING input
  WHERE input.stage = 'finalizations'
    AND seen.route = input.route
    AND seen.account_id = input.account_id
    AND NOT (SELECT present FROM notice_remaining)
    AND NOT (SELECT present FROM finalization_remaining)
  RETURNING seen.account_id
), seen_remaining AS (
  SELECT EXISTS (
    SELECT 1
    FROM content.notice_seen AS seen
    CROSS JOIN input
    WHERE seen.route = input.route
      AND seen.account_id = input.account_id
      AND NOT EXISTS (SELECT 1 FROM deleted_seen AS deleted WHERE deleted.account_id = seen.account_id)
  ) AS present
)
SELECT
  (SELECT count(*)::integer FROM deleted_notice) AS found,
  CASE
    WHEN (SELECT present FROM notice_remaining) THEN 'notices'
    WHEN (SELECT present FROM finalization_remaining) OR (SELECT present FROM seen_remaining) THEN 'finalizations'
    ELSE NULL
  END AS "nextStage",
  NOT (
    (SELECT present FROM notice_remaining)
    OR (SELECT present FROM finalization_remaining)
    OR (SELECT present FROM seen_remaining)
  ) AS done,
  (
    (SELECT present FROM notice_remaining)
    OR (SELECT present FROM finalization_remaining)
    OR (SELECT present FROM seen_remaining)
  )::integer AS pending,
  (SELECT created_at::text FROM deleted_notice ORDER BY created_at ASC, notice_id ASC LIMIT 1) AS "noticeCreatedAt",
  (SELECT notice_id::text FROM deleted_notice ORDER BY created_at ASC, notice_id ASC LIMIT 1) AS "noticeId",
  (SELECT created_at::text FROM deleted_finalization ORDER BY created_at DESC, kind DESC, source_id DESC LIMIT 1)
    AS "finalizationCreatedAt",
  (SELECT kind FROM deleted_finalization ORDER BY created_at DESC, kind DESC, source_id DESC LIMIT 1)
    AS "finalizationKind",
  (SELECT source_id::text FROM deleted_finalization ORDER BY created_at DESC, kind DESC, source_id DESC LIMIT 1)
    AS "finalizationSourceId";
