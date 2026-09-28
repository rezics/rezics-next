-- The audit explorer finds a record by the request ID a toast or a user
-- quoted, and filters by reason code without scanning the period.
CREATE INDEX IF NOT EXISTS account_audit_request ON public.rezics_account_operator_audit (request_id);
CREATE INDEX IF NOT EXISTS account_audit_reason_code ON public.rezics_account_operator_audit (reason_code, occurred_at DESC, id DESC)
  WHERE reason_code IS NOT NULL;
