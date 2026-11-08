import type { Access } from '../request/access.ts';
/** Build an Access adapter while preserving the identity of its installed ports.
 * Typed parent authorization uses the page ports; dropping them fails closed
 * with no evidence deadline (Global `realm:create` / `space:create`).
 */
export declare function deriveAccess(base: Access, overrides: Partial<Access>): Access;
/** Resolve the original Access through any number of derived adapters. */
export declare function accessRoot(access: Access): Access;
