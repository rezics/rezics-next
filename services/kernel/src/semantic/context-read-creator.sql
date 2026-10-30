-- Current resource custody survives a creator's erasure or transfer. Editorial provenance is not read authority.
SELECT role.subject_id::text AS "accountId"
FROM access.resource_role_grant AS role
JOIN access.account AS account
  ON account.route=((get_byte(uuid_send(role.subject_id),10)*256)+get_byte(uuid_send(role.subject_id),11))
 AND account.account_id=role.subject_id
 AND account.state='active' AND NOT account.authn_fenced
WHERE role.route=:route::integer AND role.resource_id=:context_id::uuid
 AND role.subject_kind='identity' AND role.subject_role=''
 AND role.grant_role='semantic.context.owner' AND role.valid @> statement_timestamp()
ORDER BY role.subject_id
LIMIT 1;
