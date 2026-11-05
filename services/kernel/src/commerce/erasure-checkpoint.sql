UPDATE commerce.erasure_progress SET cursor_id = :cursor::uuid, phase = :phase::text,
  blocker = NULLIF(:blocker::text, ''),
  retention_store = COALESCE(:retention_store::text,retention_store),
  retention_fields = COALESCE(:retention_fields::text[],retention_fields),
  retention_purpose = COALESCE(:retention_purpose::text,retention_purpose),
  retention_expires_at = COALESCE(:retention_expires_at::timestamptz,retention_expires_at)
WHERE route = :route::integer AND account_id = :account_id::uuid;
