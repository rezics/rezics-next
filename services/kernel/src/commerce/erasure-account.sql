-- This lock is a commit fence, including late first applications. Accounting can proceed after T.
SELECT state FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR SHARE;
