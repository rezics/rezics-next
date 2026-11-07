import * as v from 'valibot';
import type { AccountNavigationHref, AccountNavigationPath } from './ports/accounts';
import type { ManagementDetail } from './managed-account-contract';
import type { AuthActionName, ManagedAuthNavigation } from './managed-account-vocabulary';
const id = v.pipe(v.string(), v.uuid());

// LOCAL compatibility validator until the additive native field reaches the generated client.
// The existing management GET remains the only source; these literals describe entry observations only.
const LOCAL_authActionsSchema = v.variant('state', [
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
          resource: v.strictObject({ route: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)), id }),
        }),
      ),
      v.maxLength(4),
      v.check((entries) => new Set(entries.map((entry) => entry.operationId)).size === entries.length),
    ),
  }),
]);
export type LOCAL_ManagedAuthOperationId = Extract<
  v.InferOutput<typeof LOCAL_authActionsSchema>,
  { state: 'ready' }
>['operations'][number]['operationId'];
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
  operationId: LOCAL_ManagedAuthOperationId;
  name: AuthActionName;
  action: string;
  path: AccountNavigationPath;
}[];

/** Project only the real native observation, on the server, through Accounts' deployment allowlist. */
export function projectManagedAuthNavigation(
  native: unknown,
  detail: ManagementDetail,
  viewerId: string,
  navigationHref: AccountNavigationHref,
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
  const parsed = v.safeParse(LOCAL_authActionsSchema, native);
  if (!parsed.success || parsed.output.state !== 'ready') return closed();
  const navigation = closed();
  for (const binding of authBindings) {
    const entry = parsed.output.operations.find((entry) => entry.operationId === binding.operationId);
    const sourceId = binding.name === 'transfer' ? detail.relation?.operatorAccountId : detail.account.id;
    if (entry) {
      // Match the full native key, including the UUID's embedded route (route/route.ts bytes 10–11).
      // This is key consistency validation, not an Access evaluation or authority derived from an alias.
      if (
        entry.action !== binding.action ||
        entry.resource.id !== sourceId ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.resource.id) ||
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
    // Transfer selects the operated account; its authority resource above is the actual SOURCE operator.
    const href = navigationHref(binding.path, binding.name === 'rename' ? undefined : detail.account.id);
    navigation.actions[binding.name] = href ? { state: 'available', href } : unavailable('session/auth-page-routes.ts');
  }
  return navigation;
}

function unavailable(owner: string): { state: 'unavailable'; owner: string } {
  return { state: 'unavailable', owner };
}
