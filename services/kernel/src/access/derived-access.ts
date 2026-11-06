import type { Access } from '../request/access.ts';
import { inheritOriginalAuthenticator } from './authentication-work.ts';

const bases = new WeakMap<Access, Access>();

/** Build an Access adapter while preserving the identity of its installed ports.
 * Typed parent authorization uses the page ports; dropping them fails closed
 * with no evidence deadline (Global `realm:create` / `space:create`).
 */
export function deriveAccess(base: Access, overrides: Partial<Access>): Access {
  const authenticate = base.authenticate.bind(base);
  inheritOriginalAuthenticator(base.authenticate, authenticate);
  const derived: Access = {
    authenticate,
    ...(base.kindAudience ? { kindAudience: base.kindAudience } : {}),
    ...(base.prepareReadDecisions ? { prepareReadDecisions: base.prepareReadDecisions.bind(base) } : {}),
    ...(base.prepare ? { prepare: base.prepare.bind(base) } : {}),
    ...(base.preparePage ? { preparePage: base.preparePage.bind(base) } : {}),
    ...(base.authorizePage ? { authorizePage: base.authorizePage.bind(base) } : {}),
    ...(base.authorizeExplicit ? { authorizeExplicit: base.authorizeExplicit.bind(base) } : {}),
    ...(base.replayAuthorization ? { replayAuthorization: base.replayAuthorization.bind(base) } : {}),
    authorize: base.authorize.bind(base),
    ...(base.kindAudience ? { kindAudience: base.kindAudience } : {}),
    ...overrides,
  };
  bases.set(derived, base);
  return derived;
}

/** Resolve the original Access through any number of derived adapters. */
export function accessRoot(access: Access): Access {
  let root = access;
  let base: Access | undefined;
  while ((base = bases.get(root))) root = base;
  return root;
}
