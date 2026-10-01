CREATE TABLE IF NOT EXISTS public.rezics_content_preferences (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0),
  birth_date date,
  country text CHECK (country ~ '^[A-Z]{2}$'),
  birthday_public boolean NOT NULL DEFAULT false,
  public_id uuid UNIQUE,
  general boolean NOT NULL DEFAULT true,
  r15 boolean,
  r18 boolean NOT NULL DEFAULT false,
  r18g boolean NOT NULL DEFAULT false,
  CHECK (NOT birthday_public OR (birth_date IS NOT NULL AND public_id IS NOT NULL)),
  CHECK (birthday_public OR public_id IS NULL)
);
