import * as v from 'valibot';

const id = v.pipe(v.string(), v.uuid());
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AuthManagementPath =
  | '/account/rename'
  | '/organizations/members'
  | '/operators/transfer'
  | '/organizations/delete';
export type AuthActionName = 'rename' | 'members' | 'transfer' | 'delete';
type Availability = { state: 'denied' } | { state: 'unavailable'; owner: string };
type AuthAvailability = Availability | { state: 'available'; href: string };
export type ManagedAuthNavigation = {
  accountId: string;
  viewerId: string;
  actions: Record<AuthActionName, AuthAvailability>;
};
export type ManagedAuthTarget = {
  account: { id: string; kind: 'actor' | 'organization' };
  self: boolean;
  operator: { id: string } | null;
  relation: { operatorAccountId: string } | null;
};
type AuthManagementEnv = Readonly<{ AUTH_ISSUER?: string; AUTH_MANAGEMENT_PAGE_ROUTES?: string }>;

const paths: readonly AuthManagementPath[] = [
  '/account/rename',
  '/organizations/members',
  '/operators/transfer',
  '/organizations/delete',
];
const authActionsSchema = v.variant('state', [
  v.strictObject({ state: v.literal('unavailable') }),
  v.strictObject({
    state: v.literal('ready'),
    operations: v.pipe(
      v.array(
        v.strictObject({
          operationId: v.picklist([
            'auth.account.rename',
            'auth.organization.membership',
            'auth.operator.transfer',
            'auth.organization.delete',
          ]),
          action: v.string(),
          resource: v.strictObject({
            route: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)),
            id,
          }),
        }),
      ),
      v.maxLength(4),
      v.check((entries) => new Set(entries.map((entry) => entry.operationId)).size === entries.length),
    ),
  }),
]);
const authBindings = [
  { operationId: 'auth.account.rename', name: 'rename', action: 'account:update', path: '/account/rename' },
  {
    operationId: 'auth.organization.membership',
    name: 'members',
    action: 'organization:membership',
    path: '/organizations/members',
  },
  { operationId: 'auth.operator.transfer', name: 'transfer', action: 'account:manage', path: '/operators/transfer' },
  { operationId: 'auth.organization.delete', name: 'delete', action: 'account:delete', path: '/organizations/delete' },
] as const satisfies readonly {
  operationId:
    | 'auth.account.rename'
    | 'auth.organization.membership'
    | 'auth.operator.transfer'
    | 'auth.organization.delete';
  name: AuthActionName;
  action: string;
  path: AuthManagementPath;
}[];

function unavailable(owner: string): Extract<Availability, { state: 'unavailable' }> {
  return { state: 'unavailable', owner };
}

function trustedIssuer(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

/** Trusted deployment configuration only; an issuer alone never advertises a deployed page. */
export function managementAuthHref(env: AuthManagementEnv, path: AuthManagementPath, targetId?: string): string | null {
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
  const issuer = trustedIssuer(env.AUTH_ISSUER);
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

/** Settings query selector for the current management target; not an admission check. */
export function managedAccountHref(settingsHref: string, accountId: string): string {
  const url = new URL(settingsHref, 'https://rezics.local');
  url.searchParams.set('managedAccount', accountId);
  url.hash = 'account';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Project only the real native observation, on the server, through this deployment allowlist. */
export function projectManagedAuthNavigation(
  native: unknown,
  detail: ManagedAuthTarget,
  viewerId: string,
  env: AuthManagementEnv,
): ManagedAuthNavigation {
  const closed = (): ManagedAuthNavigation => ({
    accountId: detail.account.id,
    viewerId,
    actions: {
      rename: unavailable('Accounts authActions'),
      members: unavailable('Accounts authActions'),
      transfer: unavailable('Accounts authActions'),
      delete: unavailable('Accounts authActions'),
    },
  });
  const parsed = v.safeParse(authActionsSchema, native);
  if (!parsed.success || parsed.output.state !== 'ready') return closed();
  const navigation = closed();
  for (const binding of authBindings) {
    const entry = parsed.output.operations.find((entry) => entry.operationId === binding.operationId);
    const sourceId = binding.name === 'transfer' ? detail.relation?.operatorAccountId : detail.account.id;
    if (entry) {
      if (
        entry.action !== binding.action ||
        entry.resource.id !== sourceId ||
        !resourceId.test(entry.resource.id) ||
        entry.resource.route !== Number.parseInt(entry.resource.id.slice(24, 28), 16) ||
        (binding.name === 'transfer' && detail.operator !== null && detail.operator.id !== sourceId)
      )
        return closed();
    }
    const applicable =
      binding.name === 'rename'
        ? detail.self && detail.account.id === viewerId && detail.account.kind === 'actor' && detail.relation === null
        : binding.name === 'transfer'
          ? detail.account.kind === 'actor' && detail.relation !== null && sourceId !== detail.account.id
          : detail.account.kind === 'organization';
    if (!entry || !applicable) {
      navigation.actions[binding.name] = { state: 'denied' };
      continue;
    }
    const href = managementAuthHref(env, binding.path, binding.name === 'rename' ? undefined : detail.account.id);
    navigation.actions[binding.name] = href
      ? { state: 'available', href }
      : unavailable('accounts/management/auth-navigation.ts');
  }
  return navigation;
}
