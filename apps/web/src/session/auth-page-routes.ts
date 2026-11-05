import { trustedAuthUrl } from '../settings/account-safety-links';

export type AuthManagementPagePath =
  | '/account/rename'
  | '/organizations/members'
  | '/operators/transfer'
  | '/organizations/delete';

const paths: readonly AuthManagementPagePath[] = [
  '/account/rename',
  '/organizations/members',
  '/operators/transfer',
  '/organizations/delete',
];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Trusted deployment configuration only; an issuer alone never advertises a deployed page. */
export function authManagementPageHref(
  env: Readonly<{ AUTH_ISSUER?: string; AUTH_MANAGEMENT_PAGE_ROUTES?: string }>,
  path: AuthManagementPagePath,
  targetId?: string,
): string | null {
  const raw = env.AUTH_MANAGEMENT_PAGE_ROUTES;
  if (typeof raw !== 'string' || raw.length > 1024 || new TextEncoder().encode(raw).byteLength > 1024) return null;
  let routes: unknown;
  try {
    routes = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !Array.isArray(routes) ||
    routes.length > 4 ||
    new Set(routes).size !== routes.length ||
    routes.some((route) => !paths.includes(route)) ||
    !paths.includes(path) ||
    !routes.includes(path)
  )
    return null;
  const issuer = trustedAuthUrl(env.AUTH_ISSUER);
  if (!issuer) return null;
  const href = new URL(path, issuer.origin);
  if (path === '/account/rename') {
    if (targetId !== undefined) return null;
  } else {
    if (typeof targetId !== 'string' || !uuid.test(targetId)) return null;
    href.searchParams.set(path === '/operators/transfer' ? 'accountId' : 'organizationId', targetId);
  }
  return href.href;
}
