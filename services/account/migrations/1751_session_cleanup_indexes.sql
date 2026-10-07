-- Queue and child probes keep each maintenance page independent of total
-- account history. Child existence checks precede parent deletion so an FK
-- cascade or SET NULL cannot exceed the explicit page's row budget.
CREATE INDEX IF NOT EXISTS account_session_cleanup_pending
  ON public.rezics_account_security (user_id) WHERE session_cleanup_pending;
CREATE INDEX IF NOT EXISTS account_session_cleanup_page
  ON public."session" ("userId", rezics_generation, id);
-- Device reads must seek only the current epoch while stale rows await cleanup.
CREATE INDEX IF NOT EXISTS account_sessions_generation_page
  ON public."session" ("userId", rezics_generation, "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS account_refresh_session_cleanup
  ON public."oauthRefreshToken" ("sessionId", id);
CREATE INDEX IF NOT EXISTS account_access_session_cleanup
  ON public."oauthAccessToken" ("sessionId", id);
CREATE INDEX IF NOT EXISTS account_access_refresh_cleanup
  ON public."oauthAccessToken" ("refreshId", id);
CREATE INDEX IF NOT EXISTS account_pending_consent_session_cleanup
  ON public.rezics_account_pending_consent (session_id, id);
