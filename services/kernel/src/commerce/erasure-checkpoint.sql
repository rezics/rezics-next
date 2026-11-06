UPDATE commerce.erasure_progress SET cursor_id = :cursor::uuid, phase = :phase::text,
  blocker = NULLIF(:blocker::text, ''),
  retention_store = COALESCE(:retention_store::nullable(text),retention_store),
  retention_fields = COALESCE(:retention_fields::nullable(text[]),retention_fields),
  retention_purpose = COALESCE(:retention_purpose::nullable(text),retention_purpose),
  retention_expires_at = COALESCE(:retention_expires_at::nullable(timestamptz),retention_expires_at)
WHERE route = :route::integer AND account_id = :account_id::uuid;
