-- Holder pages and the role-card preview seek one role's members in member-id
-- order. The primary key is already (realm, role_id, member); covering
-- valid_until keeps the live-assignment filter on that index.
CREATE INDEX realm_admin_assignment_role_holders
  ON access.realm_admin_assignment (realm, role_id, member) INCLUDE (valid_until);
