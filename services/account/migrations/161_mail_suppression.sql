CREATE TABLE IF NOT EXISTS public.rezics_mail_suppression (
  address text NOT NULL,
  purpose text NOT NULL CHECK (purpose = 'digest'),
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint')),
  source text NOT NULL,
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, purpose)
);
CREATE TABLE IF NOT EXISTS public.rezics_mail_event (
  source text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, event_id)
);
