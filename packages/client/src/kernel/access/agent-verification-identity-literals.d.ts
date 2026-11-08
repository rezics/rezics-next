/** Literal-only account identity SQL. Adapters import this leaf; they do not evaluate identity work at load. */
/** Account terminal fence preceding any intent or technical disclosure. */
export declare const ACCOUNT_IDENTITY_FENCE_SQL = "SELECT kind,state,authn_fenced FROM access.account WHERE route=$1 AND account_id=$2 FOR SHARE";
