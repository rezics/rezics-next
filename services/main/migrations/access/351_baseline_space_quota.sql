-- Private platform policy. A principal, rather than each of its Person Agents,
-- is the beneficiary, so creating pen names never creates additional capacity.
INSERT INTO quota.policy (id, scope, unit, head_revision) VALUES
    ('00000000-0000-8000-8000-000000000351',
     'https://rezics.com/id/00000000-0000-8000-8000-000000000351', 'member-space-create', 1);
INSERT INTO quota.policy_revision (policy_id, revision, period, base_allowance,
    max_reservation, reservation_ttl, failure_policy) VALUES
    ('00000000-0000-8000-8000-000000000351', 1, 'P1M', 3, 1, interval '30 seconds', 'release');
