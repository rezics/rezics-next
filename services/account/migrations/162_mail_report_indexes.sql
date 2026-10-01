-- The report counts uncertain delivery without scanning sent/expired history.
CREATE INDEX IF NOT EXISTS account_email_uncertain ON public.rezics_account_email (id)
  WHERE state = 'uncertain';
CREATE INDEX IF NOT EXISTS account_mail_suppression_reason ON public.rezics_mail_suppression (reason);
