-- A bulk job may wait out an undo window before its first item runs; its
-- actor can cancel what is still pending (all of it, inside the window).
ALTER TABLE public.rezics_account_operator_job ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE public.rezics_account_operator_job ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_job_item_state') THEN
    -- Keeps every state 045 allowed and adds `cancelled`.
    ALTER TABLE public.rezics_account_operator_job_item DROP CONSTRAINT IF EXISTS rezics_account_operator_job_item_state_check;
    ALTER TABLE public.rezics_account_operator_job_item ADD CONSTRAINT account_job_item_state
      CHECK (state IN ('pending', 'succeeded', 'skipped', 'failed', 'cancelled'));
  END IF;
END $$;
