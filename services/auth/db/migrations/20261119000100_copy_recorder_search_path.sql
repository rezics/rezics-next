-- migrate:up
-- DBOS retires the original writer under its own restricted search path.
ALTER FUNCTION public.auth_copy_record() SET search_path TO pg_catalog, public, pg_temp;

-- migrate:down
ALTER FUNCTION public.auth_copy_record() RESET search_path;
