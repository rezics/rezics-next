-- Risk signals on the operator overview read recent security events by kind
-- and time across all accounts: each kind is a bounded range of this partial
-- index. A review is an audit record on the signal's subject (a user or an
-- App) carrying the signal key, so it is found by the audit target index.
CREATE INDEX IF NOT EXISTS account_signal_events ON public.rezics_account_security_event (action, occurred_at DESC)
  WHERE action IN ('passkey_added', 'email_changed', 'consent_granted');
CREATE INDEX IF NOT EXISTS account_audit_signal_review ON public.rezics_account_operator_audit (target_id, occurred_at DESC)
  WHERE action = 'signal_reviewed';
