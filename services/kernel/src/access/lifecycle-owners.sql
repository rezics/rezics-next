SELECT count(*)::integer AS owners,
       count(*) FILTER (WHERE member_account_id = :member_id)::integer AS target
FROM access.organization_member
WHERE route = :route AND organization_id = :organization_id AND role = 'owner' AND valid @> :at::timestamptz;
