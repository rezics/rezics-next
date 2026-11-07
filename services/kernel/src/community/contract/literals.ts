/** Literal-only Community identity strings and patterns. Events import this leaf; they do not evaluate the contract barrel at load. */

/** Log event identity. The outbox stores any RFC 4122 version the command executor assigned. */
export const COMMUNITY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Routed Space, Realm, Context and media identities. Version 7 or 8, RFC 4122 variant. */
export const COMMUNITY_ROUTED_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Native log and partition positions, including the empty-head zero. */
export const COMMUNITY_LOG_POSITION_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

export const COMMUNITY_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const COMMUNITY_ROUTED_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
export const COMMUNITY_LOG_POSITION = '^(0|[1-9][0-9]{0,18})$';
