CREATE TABLE IF NOT EXISTS public.rezics_display_preferences (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  display_mode text NOT NULL CHECK (display_mode IN ('system', 'light', 'dark')),
  show_zone_themes boolean NOT NULL
);
