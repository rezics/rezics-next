import type { Pool } from 'pg';
import type { Access, AccessContext, AccountActor, Resource } from '../request/access.ts';
import type { Account } from './account-data.ts';

declare const floorIdentity: unique symbol;
export type CredentialFloorIdentity = { readonly [floorIdentity]: true };
export const floorIdentities = new WeakMap<
  CredentialFloorIdentity,
  { actor: AccountActor; account: Account; pool: Pool }
>();
export const floorBridges = new WeakMap<
  Access,
  (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>
>();
/** Installed once by the ordinary Access factory; no actor JSON registration. */
export function installCredentialFloorBridge(
  access: Access,
  bridge: (proof: CredentialFloorIdentity, resource: Resource, context: AccessContext) => Promise<boolean>,
) {
  if (floorBridges.has(access)) throw new Error('Credential floor bridge already installed');
  floorBridges.set(access, bridge);
}
/** Opaque evidence exists only after exact native consumed-row verification. */
export function credentialFloorIdentityClaims(proof: CredentialFloorIdentity, pool: Pool) {
  const claims = floorIdentities.get(proof);
  return claims?.pool === pool ? claims : undefined;
}
