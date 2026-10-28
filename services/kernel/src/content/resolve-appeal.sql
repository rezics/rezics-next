UPDATE content.moderation_appeal
SET outcome = :outcome::text, resolver_account_id = :resolver::uuid,
    resolver_statement = :statement::text, resolved_at = :resolved_at::timestamptz
WHERE route = :route::integer AND appeal_id = :appeal_id::uuid AND outcome IS NULL
RETURNING appeal_id;
