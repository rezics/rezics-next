export type { AccessCheck, PreparedAccessCheckInvocation, PreparedAccessCheckWork } from '../request/access.ts';
import type { Access, AccessConfig as KernelAccessConfig, ActionCatalogue } from '../request/access.ts';
import { type AuthenticationConfig } from './authenticate.ts';
export type AccessConfig = KernelAccessConfig & {
    auth?: AuthenticationConfig;
};
/** Fixed native checks without mounted routes; call sites are listed in the Access README. */
export declare const INTERNAL_ACTIONS: ActionCatalogue;
/** Also called at kernel startup, before its lazy Access is first used. */
export declare function assertInternalActionDeclarations(actions: ActionCatalogue): void;
export declare function accessActionCatalogue(declared: ActionCatalogue): Map<string, {
    anonymous: boolean;
    replay?: 'self-account-read';
    authority?: 'own-account';
    'x-resource-types'?: readonly string[];
}>;
/**
 * App-local Access factory; the kernel supplies the mounted route catalogue.
 * Optional auth overrides the deployment's AUTH_ISSUER (HTTPS origin),
 * AUTH_AUDIENCE (HTTPS API URL), and AUTH_JWKS_URL (HTTPS public JWKS on the
 * issuer origin). All three are required only when authentication is used.
 * Only ES256 public keys are accepted; Auth credentials/private keys are never needed.
 */
export declare function createAccess(config: AccessConfig): Access;
/** Standalone instance denies authorization until an app supplies its own catalogue. */
export declare function access(): Access;
export type { ResourceRoleCatalogue } from './resource-roles.ts';
