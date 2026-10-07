-- Run as the cluster administrator, outside a transaction; restart afterwards.
SET statement_timeout = '5s';
SET lock_timeout = '5s';
GRANT pg_read_all_stats TO access, content WITH INHERIT TRUE;
ALTER SYSTEM SET max_prepared_transactions = '0';
