-- unbound: Global partition only: one primary-key seek for the fixed Global Context client-management anchor.
SELECT context_id FROM semantic.context
WHERE route = 0 AND context_id = '00000000-0000-8000-8000-000000000000' AND kind = 'global';
