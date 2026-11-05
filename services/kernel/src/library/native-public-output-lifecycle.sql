SELECT 1 FROM access.account
WHERE route=$1 AND account_id=$2 AND state='active' AND NOT authn_fenced;
