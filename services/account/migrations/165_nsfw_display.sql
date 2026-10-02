-- NSFW presentation is independent of age-category eligibility and opt-ins.
ALTER TABLE public.rezics_content_preferences
  ADD COLUMN IF NOT EXISTS nsfw_display text NOT NULL DEFAULT 'mask'
    CHECK (nsfw_display IN ('mask', 'show'));
