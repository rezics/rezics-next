-- migrate:up
ALTER TABLE semantic.context
  ADD COLUMN settings_id text,
  ADD COLUMN settings_release text,
  ADD COLUMN defaults jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT context_settings_pair_check
    CHECK ((settings_id IS NULL) = (settings_release IS NULL)),
  ADD CONSTRAINT context_settings_id_check
    CHECK (settings_id IS NULL OR settings_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT context_settings_release_check
    CHECK (settings_release IS NULL OR settings_release ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT context_defaults_check
    CHECK (
      jsonb_typeof(defaults) = 'object'
      AND NOT jsonb_path_exists(defaults, '$.* ? (@ != "inherit" && @ != "suppress")')
    ),
  ADD CONSTRAINT context_without_settings_defaults_check
    CHECK (settings_id IS NOT NULL OR defaults = '{}'::jsonb);

-- migrate:down
ALTER TABLE semantic.context
  DROP CONSTRAINT context_without_settings_defaults_check,
  DROP CONSTRAINT context_defaults_check,
  DROP CONSTRAINT context_settings_release_check,
  DROP CONSTRAINT context_settings_id_check,
  DROP CONSTRAINT context_settings_pair_check,
  DROP COLUMN defaults,
  DROP COLUMN settings_release,
  DROP COLUMN settings_id;
