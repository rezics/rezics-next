import { join, resolve } from 'node:path';

// Keep the installed provider and resource order stable: existing grants and
// consent ceilings continue to use the same exact scope tokens.
const domainScopes = [
  'work:create', 'work:edit', 'work:read', 'comment:create', 'space:create',
  'realm:adopt', 'realm:reject', 'realm:classify', 'classification:define',
  'classification:decide', 'rating:configure', 'rating:submit', 'rating:read',
  'address:claim', 'address:manage', 'access:manage', 'access:membership-consent',
  'access:approve', 'access:grant', 'access:represent', 'access:representation-manage',
  'access:role', 'source:intake', 'source:acquire', 'source:convert', 'source:propose',
  'source:correspond', 'source:adopt', 'source:read', 'package:capture',
  'package:resolve', 'package:verify', 'package:read',
] as const;

const scopePattern = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

/** Operations for these scopes sit only in a closed platform group. They stay
 * registered so a first-party site can request them for a granted user, and
 * they are hidden from third-party consent and refused in dynamic registration. */
const domainClosedGroupScopes = [
  'package:capture', 'package:resolve', 'package:verify', 'package:read',
  'source:intake', 'source:acquire', 'source:convert', 'source:propose', 'source:correspond',
] as const;

type ScopeModule = { oauthScopes?: unknown; closedGroupScopes?: unknown };

/** Account-side owner declarations are loaded once, before Better Auth starts. */
export async function discoverOAuthScopeRegistry(directory = join(import.meta.dir, 'oauth-scopes')) {
  const scopes: string[] = [...domainScopes];
  const seen = new Set<string>(scopes);
  const closed = new Set<string>();
  for (const scope of domainClosedGroupScopes) {
    if (!seen.has(scope)) throw new Error(`Closed-group scope ${scope} is not a declared OAuth scope`);
    closed.add(scope);
  }
  for (const file of [...new Bun.Glob('*.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as ScopeModule;
    if (!Array.isArray(module.oauthScopes) || module.oauthScopes.length === 0) {
      throw new Error(`OAuth scope declaration is empty in ${file}`);
    }
    const declared = new Set<string>();
    for (const scope of module.oauthScopes) {
      if (typeof scope !== 'string' || !scopePattern.test(scope) || seen.has(scope)) {
        throw new Error(`Duplicate or invalid OAuth scope ${scope} in ${file}`);
      }
      seen.add(scope);
      declared.add(scope);
      scopes.push(scope);
    }
    if (module.closedGroupScopes === undefined) continue;
    if (!Array.isArray(module.closedGroupScopes)) {
      throw new Error(`Closed-group scope declaration is invalid in ${file}`);
    }
    for (const scope of module.closedGroupScopes) {
      if (typeof scope !== 'string' || !declared.has(scope)) {
        throw new Error(`Closed-group scope ${scope} is not declared in ${file}`);
      }
      if (closed.has(scope)) throw new Error(`Duplicate closed-group scope ${scope} in ${file}`);
      closed.add(scope);
    }
  }
  return Object.freeze({
    scopes: Object.freeze(scopes),
    closedGroupScopes: Object.freeze([...closed]),
  });
}

export async function discoverOAuthScopes(directory = join(import.meta.dir, 'oauth-scopes')) {
  return (await discoverOAuthScopeRegistry(directory)).scopes;
}

const installed = await discoverOAuthScopeRegistry();
export const providerScopes = Object.freeze(['openid', 'profile', 'email', 'offline_access', ...installed.scopes]);
export const resourceScopes = Object.freeze(['openid', 'offline_access', ...installed.scopes]);
export const closedGroupScopes = installed.closedGroupScopes;

const closedGroupScopeSet = new Set<string>(closedGroupScopes);

/** First-party clients keep every requested scope. A third party is offered
 * only scopes that also serve an open group. */
export function consentScopes(requested: readonly string[], firstParty: boolean): readonly string[] {
  if (firstParty) return requested;
  return requested.filter(scope => !closedGroupScopeSet.has(scope));
}

/** Dynamic registration stores this ceiling. Closed-group scopes stay
 * registered for first-party clients and cannot be taken here. */
export function dynamicRegistrationScopes(scopes: readonly string[]): string[] {
  return scopes.filter(scope => !closedGroupScopeSet.has(scope));
}
