import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import type { SessionEnv } from '../session/client';
import { authManagementPageHref, type AuthManagementPagePath } from '../session/auth-page-routes';
import { managedAccountsException, managedAccountsFailure } from './managed-accounts-read';

const id = v.pipe(v.string(), v.uuid());
const selection = v.strictObject({ accountId: id, viewerId: id });
export type ManagedAccountActionsSelection = v.InferOutput<typeof selection>;
export type ManagedAccountActionsTarget = {
  accountId: string;
  nativeAccountKind: 'actor' | 'organization';
  operated: boolean;
  self: boolean;
};
export type AuthManagementPath = AuthManagementPagePath;
type AuthManagementEnv = Parameters<typeof authManagementPageHref>[0];

/** Closed compatibility port retained for the original unavailable-port oracle.
 * Production reads use Accounts' canonical deployment helper below. */
export const LOCAL_authManagementPageHref = (
  _env: AuthManagementEnv,
  _path: AuthManagementPath,
  _targetId?: string,
): string | null => null;

export type ManagedActionName = 'profile' | 'rename' | 'members' | 'transfer' | 'delete';
type Availability = { state: 'available' } | { state: 'denied' } | { state: 'unavailable'; owner: string };
export type ManagedAccountActionsResult =
  | {
      state: 'ready';
      accountId: string;
      viewerId: string;
      actions: Record<ManagedActionName, Availability>;
    }
  | { state: 'denied' | 'unavailable'; status: number | null; code: string | null };
export type ManagedAccountActionsIO = (target: ManagedAccountActionsSelection) => Promise<ManagedAccountActionsResult>;

const response = v.strictObject({
  resources: v.tuple([
    v.variant('type', [
      v.strictObject({
        type: v.literal('access.account'),
        id,
        viewerActions: v.array(v.strictObject({ action: v.string(), operations: v.array(v.string()) })),
      }),
    ]),
  ]),
});

function failure(status: number | null, body?: unknown): ManagedAccountActionsResult {
  const result = managedAccountsFailure(status, body);
  return { state: result.kind, status: result.status, code: result.code };
}
function exception(error: unknown): ManagedAccountActionsResult {
  const result = managedAccountsException(error);
  return { state: result.kind, status: result.status, code: result.code };
}
function unavailable(owner: string): Availability {
  return { state: 'unavailable', owner };
}

/** Deployment never supplies a missing native operation binding. No Auth URL reaches the browser yet. */
function unmappedAuthAction(
  env: AuthManagementEnv,
  path: AuthManagementPagePath,
  targetId: string | undefined,
  nativeOwner: string,
): Availability {
  const deployed = authManagementPageHref(env, path, targetId);
  return unavailable(deployed ? nativeOwner : `${nativeOwner}; session/auth-page-routes.ts`);
}

/** One current exact-target native read; no inventory/role/reservation inference and no fake transport. */
export async function loadManagedAccountActions(
  client: KernelClient,
  authorization: string,
  target: ManagedAccountActionsSelection,
  env: AuthManagementEnv = {},
): Promise<ManagedAccountActionsResult> {
  try {
    v.parse(selection, target);
    const result = await client.viewerActions.post(
      { resources: [{ type: 'access.account', id: target.accountId }] },
      { headers: { authorization, 'cache-control': 'no-store' }, fetch: { cache: 'no-store' } },
    );
    if (result.error || result.status !== 200) return failure(result.status, result.error?.value);
    // A hidden native resource is a denial, not an empty successful capability response.
    const hidden = v.safeParse(
      v.strictObject({
        resources: v.tuple([
          v.strictObject({
            type: v.literal('access.account'),
            id: v.literal(target.accountId),
            error: v.literal('not_found'),
          }),
        ]),
      }),
      result.data,
    );
    if (hidden.success) return { state: 'denied', status: result.status, code: 'not_found' };
    const parsed = v.safeParse(response, result.data);
    if (!parsed.success || parsed.output.resources[0].id !== target.accountId) return failure(null);
    const actions = parsed.output.resources[0].viewerActions;
    // routes.ts account.update uses native profile authority: account:update or the current operator's
    // account:manage. Both must carry that exact installed operation on THIS native account resource.
    const profile = actions.some(
      (entry) =>
        ['account:update', 'account:manage'].includes(entry.action) && entry.operations.includes('account.update'),
    );
    return {
      state: 'ready',
      ...target,
      actions: {
        profile: { state: profile ? 'available' : 'denied' },
        // Auth workflow commands exist, but the current native viewerActions catalogue has no exact
        // per-operation bindings for these destinations. Generic account.update is NOT rename authority.
        // Accounts owns those bindings; session/auth-page-routes.ts owns installed Auth destinations.
        rename: unmappedAuthAction(env, '/account/rename', undefined, 'Accounts viewerActions: rename'),
        members: unmappedAuthAction(
          env,
          '/organizations/members',
          target.accountId,
          'Accounts viewerActions: organization membership',
        ),
        transfer: unmappedAuthAction(
          env,
          '/operators/transfer',
          target.accountId,
          'Accounts viewerActions: operator transfer',
        ),
        delete: unmappedAuthAction(
          env,
          '/organizations/delete',
          target.accountId,
          'Accounts viewerActions: organization deletion',
        ),
      },
    };
  } catch (error) {
    return exception(error);
  }
}

/** The browser supplies selection, never an actor or bearer; bind it to the live cookie viewer. */
export const readManagedAccountActions = createServerFn({ method: 'GET' })
  .validator((input: unknown) => v.parse(selection, input))
  .handler(async ({ data }): Promise<ManagedAccountActionsResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { boundViewer } = await import('../accounts/profile-editor/request');
    try {
      const authorization = await boundViewer(getRequest(), env as Partial<SessionEnv>, data.viewerId);
      if (!authorization) return { state: 'denied', status: 401, code: 'authentication_required' };
      if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) return failure(null);
      const { kernelClient } = await import('../kernel/client');
      return await loadManagedAccountActions(kernelClient(), authorization, data, env as Partial<SessionEnv>);
    } catch (error) {
      return exception(error);
    }
  });

/** A mounted target owns one promise, including React effect reattachment. No polling or shared target cache. */
export class ManagedAccountActionsRead {
  private pending?: Promise<ManagedAccountActionsResult>;
  constructor(
    private readonly target: ManagedAccountActionsSelection,
    private readonly io: ManagedAccountActionsIO,
  ) {}
  load(): Promise<ManagedAccountActionsResult> {
    return (this.pending ??= Promise.resolve()
      .then(() => this.io(this.target))
      .then((result) =>
        result.state === 'ready' &&
        (result.accountId !== this.target.accountId || result.viewerId !== this.target.viewerId)
          ? failure(null)
          : result,
      )
      .catch(exception));
  }
}

/** These presentation restrictions can only remove choices; native capability remains mandatory. */
export function managedAccountActionNames(target: ManagedAccountActionsTarget, viewerId: string): ManagedActionName[] {
  return [
    'profile',
    ...(target.self && target.accountId === viewerId && target.nativeAccountKind === 'actor' && !target.operated
      ? (['rename'] as const)
      : []),
    ...(target.nativeAccountKind === 'organization' ? (['members', 'delete'] as const) : []),
    ...(target.operated && target.nativeAccountKind === 'actor' ? (['transfer'] as const) : []),
  ];
}
