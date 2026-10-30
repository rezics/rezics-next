SELECT curator_account_id AS "curatorAccountId", visibility, state,
       membership_kind AS "membershipKind", builtin_kind AS "builtinKind",
       rule_filter IS NOT NULL AS "hasSavedRule"
FROM library.collection
WHERE route = :route::integer AND collection_id = :collection_id::uuid;
