-- Invitations are evidence, not assignments. Identity snapshots in history
-- survive account deletion; only the current policy points at a live guardian.
CREATE TABLE IF NOT EXISTS public.rezics_account_recovery_guardian_invitation (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL,
  guardian_email text NOT NULL,
  state text NOT NULL CHECK (state IN
    ('pending','accepted','declined','withdrawn','cancelled','spent','unconfirmed')),
  guardian_user_id text,
  legacy_guardian_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_at timestamptz,
  ended_at timestamptz,
  CHECK (guardian_user_id IS NULL OR guardian_user_id <> owner_user_id),
  CHECK (state <> 'accepted' OR (guardian_user_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS account_guardian_pending_mailbox
  ON public.rezics_account_recovery_guardian_invitation (guardian_email, expires_at, id)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS account_guardian_accepted_identity
  ON public.rezics_account_recovery_guardian_invitation (guardian_user_id, id)
  WHERE state = 'accepted';

ALTER TABLE public.rezics_account_recovery_policy
  ADD COLUMN IF NOT EXISTS guardian_invitation_id uuid
    REFERENCES public.rezics_account_recovery_guardian_invitation(id);
-- Re-enrolling the same code after withdrawal must never revive an old
-- approval. Claims bind to the exact consent, independently of credential fences.
ALTER TABLE public.rezics_account_recovery_claim
  ADD COLUMN IF NOT EXISTS guardian_invitation_id uuid
    REFERENCES public.rezics_account_recovery_guardian_invitation(id);
ALTER TABLE public.rezics_account_recovery_policy ALTER COLUMN guardian_user_id DROP NOT NULL;
ALTER TABLE public.rezics_account_recovery_policy
  DROP CONSTRAINT IF EXISTS rezics_account_recovery_policy_guardian_user_id_fkey;
ALTER TABLE public.rezics_account_recovery_policy
  ADD CONSTRAINT rezics_account_recovery_policy_guardian_user_id_fkey
    FOREIGN KEY (guardian_user_id) REFERENCES public."user"(id) ON DELETE SET NULL;

-- Existing assignments never established consent. Keep their original identity
-- as evidence, disable their proofs, and require a new explicit invitation.
WITH retained AS (
  INSERT INTO public.rezics_account_recovery_guardian_invitation
    (id, owner_user_id, guardian_email, state, legacy_guardian_user_id, expires_at)
    SELECT gen_random_uuid(), p.id, u.email, 'unconfirmed', p.guardian_user_id, now()
    FROM public.rezics_account_recovery_policy p JOIN public."user" u ON u.id = p.guardian_user_id
    WHERE p.guardian_invitation_id IS NULL
    RETURNING id, owner_user_id
)
UPDATE public.rezics_account_recovery_policy p SET guardian_invitation_id = r.id,
  guardian_user_id = NULL, code_hash = NULL FROM retained r WHERE p.id = r.owner_user_id;

-- Historical subject IDs remain evidence after either participant deletes an
-- account. Retaining claims also retains their approvals and activation receipts.
ALTER TABLE public.rezics_account_recovery_approval
  DROP CONSTRAINT IF EXISTS rezics_account_recovery_approval_approver_user_id_fkey;
ALTER TABLE public.rezics_account_recovery_claim
  DROP CONSTRAINT IF EXISTS rezics_account_recovery_claim_target_user_id_fkey;

CREATE OR REPLACE FUNCTION public.rezics_guard_guardian_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.rezics_account_recovery_policy p
    JOIN public.rezics_account_recovery_guardian_invitation i ON i.id = p.guardian_invitation_id
    WHERE p.guardian_user_id = OLD.id AND p.code_hash IS NOT NULL AND i.state = 'accepted') THEN
    RAISE EXCEPTION 'Withdraw accepted recovery guardianships before deletion' USING ERRCODE = '23503';
  END IF;
  UPDATE public.rezics_account_recovery_guardian_invitation SET state = 'cancelled', ended_at = now()
    WHERE id = (SELECT guardian_invitation_id FROM public.rezics_account_recovery_policy WHERE id = OLD.id)
      AND state IN ('pending','accepted');
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS account_guardian_deletion ON public."user";
CREATE TRIGGER account_guardian_deletion BEFORE DELETE ON public."user"
  FOR EACH ROW EXECUTE FUNCTION public.rezics_guard_guardian_deletion();
