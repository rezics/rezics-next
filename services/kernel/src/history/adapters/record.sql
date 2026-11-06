INSERT INTO core.history_locator
  (partition_no, account_route, account_id, artifact_type, locator, roles, minimizer_version)
SELECT :partition_no::integer, a."accountRoute", a."accountId", :artifact_type::text, :locator::bytea, a.roles, 1
FROM jsonb_to_recordset(:accounts::jsonb) AS a("accountRoute" integer, "accountId" uuid, roles integer)
ORDER BY a."accountRoute", a."accountId";
