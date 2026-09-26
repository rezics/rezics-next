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

/** Account-side owner declarations are loaded once, before Better Auth starts. */
export async function discoverOAuthScopes(directory = join(import.meta.dir, 'oauth-scopes')) {
  const result: string[] = [...domainScopes];
  const seen = new Set<string>(result);
  for (const file of [...new Bun.Glob('*.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as { oauthScopes?: unknown };
    if (!Array.isArray(module.oauthScopes) || module.oauthScopes.length === 0) {
      throw new Error(`OAuth scope declaration is empty in ${file}`);
    }
    for (const scope of module.oauthScopes) {
      if (typeof scope !== 'string' || !/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(scope)
        || seen.has(scope)) throw new Error(`Duplicate or invalid OAuth scope ${scope} in ${file}`);
      seen.add(scope);
      result.push(scope);
    }
  }
  return Object.freeze(result);
}

const installedScopes = await discoverOAuthScopes();
export const providerScopes = Object.freeze(['openid', 'profile', 'email', 'offline_access', ...installedScopes]);
export const resourceScopes = Object.freeze(['openid', 'offline_access', ...installedScopes]);
