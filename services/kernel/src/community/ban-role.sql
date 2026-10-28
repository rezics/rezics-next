-- Two exact temporal grant keys, independent of membership and permission denials.
SELECT EXISTS (
  SELECT 1 FROM access.resource_role_grant
  WHERE route = :route::integer AND resource_id = :realm_id::uuid
    AND subject_kind = 'identity' AND subject_id = :account_id::uuid AND subject_role = ''
    AND grant_role IN ('community.realm.owner', 'community.realm.moderator')
    AND valid @> :at::timestamptz
) AS protected;
