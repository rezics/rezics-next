SELECT count::text AS count, version::text AS version
FROM community.realm_member_count
WHERE route=:route::integer AND realm_id=:realm_id::uuid
  AND keyed AND initialized AND removal_coverage AND horizon<=:at::timestamptz;
