import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedReaderCurrent } from './managed-session-reader';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import type { SessionEnv } from '../session/client';
import { authManagementPageHref, type AuthManagementPagePath } from '../session/auth-page-routes';
import { MediaProblem } from '../media/kernel';
import { managedAccountsException, managedAccountsFailure } from './managed-accounts-read';
import { detailFailure, type ManagementDetail } from './managed-account-detail-read';
import { preferenceRetryDeadline } from './preference-failure-retry';

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
type AuthActionName = Exclude<ManagedActionName, 'profile'>;
type AuthAvailability = Exclude<Availability, { state: 'available' }> | { state: 'available'; href: string };
/** Web-private projection of a server-owned management GET, never an input to a native request. */
export type ManagedAuthNavigation = {
  accountId: string;
  viewerId: string;
  actions: Record<AuthActionName, AuthAvailability>;
};

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
  path: AuthManagementPath;
}[];

/** Project only the real native observation, on the server, through Accounts' deployment allowlist. */
export function projectManagedAuthNavigation(
  native: unknown,
  detail: ManagementDetail,
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
    const href = authManagementPageHref(env, binding.path, binding.name === 'rename' ? undefined : detail.account.id);
    navigation.actions[binding.name] = href ? { state: 'available', href } : unavailable('session/auth-page-routes.ts');
  }
  return navigation;
}
export type ManagedAccountActionsResult =
  | {
      state: 'ready';
      accountId: string;
      viewerId: string;
      actions: Record<ManagedActionName, Availability>;
    }
  | { state: 'denied' | 'unavailable'; status: number | null; code: string | null; retryAfter?: string };
export type ManagedAccountActionsIO = (
  target: ManagedAccountActionsSelection,
  signal?: AbortSignal,
) => Promise<ManagedAccountActionsResult>;

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

function failure(
  status: number | null,
  body?: unknown,
  headers?: HeadersInit,
): Extract<ManagedAccountActionsResult, { state: 'denied' | 'unavailable' }> {
  const result = managedAccountsFailure(status, body);
  const { retryAfter } = detailFailure(status, body, headers);
  return { state: result.kind, status: result.status, code: result.code, ...(retryAfter ? { retryAfter } : {}) };
}
function exception(error: unknown): ManagedAccountActionsResult {
  const result = managedAccountsException(error);
  return failure(result.status, { code: result.code }, error instanceof MediaProblem ? error.headers : undefined);
}
function unavailable(owner: string): Extract<Availability, { state: 'unavailable' }> {
  return { state: 'unavailable', owner };
}

/** The profile-only read cannot supply Auth bindings; the management GET projects those independently. */
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
  signal?: AbortSignal,
): Promise<ManagedAccountActionsResult> {
  try {
    v.parse(selection, target);
    const result = await withManagedReadDeadline(
      (signal) =>
        client.viewerActions.post(
          { resources: [{ type: 'access.account', id: target.accountId }] },
          { headers: { authorization, 'cache-control': 'no-store' }, fetch: { cache: 'no-store', signal } },
        ),
      signal,
    );
    if (result.error || result.status !== 200) return failure(result.status, result.error?.value, result.headers);
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
    if (hidden.success) return { ...failure(result.status, { code: 'not_found' }, result.headers), state: 'denied' };
    const parsed = v.safeParse(response, result.data);
    if (!parsed.success || parsed.output.resources[0].id !== target.accountId)
      return failure(result.status, undefined, result.headers);
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
      return await loadManagedAccountActions(
        kernelClient(),
        authorization,
        data,
        env as Partial<SessionEnv>,
        getRequest().signal,
      );
    } catch (error) {
      return exception(error);
    }
  });

type ActionsSnapshot = { result: ManagedAccountActionsResult | null; pending: boolean };

/** Immutable viewer/target lifetime. Effect reattachment observes the current promise; only retry replaces failures. */
export class ManagedAccountActionsRead {
  private current?: Promise<ManagedAccountActionsResult>;
  private value: ActionsSnapshot = { result: null, pending: false };
  private retryAt = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private listeners = new Set<() => void>();
  constructor(
    private readonly target: ManagedAccountActionsSelection,
    private readonly io: ManagedAccountActionsIO,
    private readonly currentOwner: ManagedReaderCurrent = () => true,
  ) {}
  snapshot = () => {
    this.live();
    return this.value;
  };
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.retryAt = 0;
    this.publish({ result: null, pending: false });
  };
  isCurrent = () => this.live();
  private live() {
    if (!this.disposed && !this.currentOwner()) this.dispose();
    return !this.disposed;
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: ActionsSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  load(): Promise<ManagedAccountActionsResult> {
    if (!this.live()) return Promise.resolve(failure(null));
    return this.current ?? this.request();
  }
  retry(): Promise<ManagedAccountActionsResult> {
    if (!this.live()) return Promise.resolve(failure(null));
    if (this.value.pending || this.value.result?.state !== 'unavailable' || Date.now() < this.retryAt)
      return this.load();
    return this.request();
  }
  private request(): Promise<ManagedAccountActionsResult> {
    this.current = Promise.resolve()
      .then(() =>
        this.live()
          ? withManagedReadDeadline((signal) => this.io(this.target, signal), this.lifetime.signal)
          : failure(null),
      )
      .then((result) =>
        result.state === 'ready' &&
        (result.accountId !== this.target.accountId || result.viewerId !== this.target.viewerId)
          ? failure(null)
          : result,
      )
      .catch(exception)
      .then((result) => {
        if (!this.live()) return failure(null);
        this.retryAt = result.state === 'unavailable' ? preferenceRetryDeadline(result.retryAfter) : 0;
        this.publish({ result, pending: false });
        return result;
      });
    this.publish({ ...this.value, pending: true });
    return this.current;
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
