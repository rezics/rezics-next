SELECT generation_id::text AS "generationId" FROM community.realm_membership_proof
WHERE route=:route::integer AND realm_id=:realm_id::uuid AND account_id=:account_id::uuid
 AND generation_id=:generation_id::uuid;
