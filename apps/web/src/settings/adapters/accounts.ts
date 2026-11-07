import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import * as v from 'valibot';
import type { SessionEnv } from '../../session/client';
import { authManagementPageHref } from '../auth-management';
import { carriesSession } from '../../session/csrf';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import { managedAccountsException } from '../managed-accounts-read';
import { serverSettingsTimer } from './ambient.ts';
import { withManagedReadDeadline } from '../managed-read-deadline';
import {
  managementSchema,
  managedAccountId as id,
  type DetailRequest,
  type DetailResult,
  type DetailFailure,
} from '../managed-account-contract';
import type {
  ManagedAccountActionsSelection,
  ManagedAccountActionsResult,
  Availability,
} from '../managed-account-vocabulary';
import { detailFailure, managedActionFailure as failure } from '../managed-account-failure';
import { projectManagedAuthNavigation as projectNavigation } from '../managed-account-projection';
import type { AccountNavigationPath as AuthManagementPagePath } from '../ports/accounts';
import { settingsMediaFailure } from './content';

type AuthManagementEnv = Parameters<typeof authManagementPageHref>[0];
const selection = v.strictObject({ accountId: id, viewerId: id });
/** Cookie custody is shared by exact-account consumers; a bearer never replaces the current viewer. */
export async function boundAccountViewer(request: Request, env: Partial<SessionEnv>, viewerId: string) {
  if (request.headers.has('authorization') || !carriesSession(request)) return null;
  await prepareSession(request, env);
  const authorization = viewerCredential(request);
  return authorization && sessionSubject(request) === viewerId ? authorization : null;
}

export function projectManagedAuthNavigation(
  native: unknown,
  detail: import('../managed-account-contract').ManagementDetail,
  viewerId: string,
  env: AuthManagementEnv,
) {
  return projectNavigation(native, detail, viewerId, (path, targetId) => authManagementPageHref(env, path, targetId));
}
/** Compatibility oracle: this deliberately unbound port supplies no destination. */
export const LOCAL_authManagementPageHref = (
  _env: AuthManagementEnv,
  _path: AuthManagementPagePath,
  _targetId?: string,
): null => null;
function exception(error: unknown): ManagedAccountActionsResult {
  const result = managedAccountsException(error, settingsMediaFailure);
  return failure(
    result.status,
    { code: result.code },
    result.retryAfter ? { 'retry-after': result.retryAfter } : undefined,
  );
}
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
      serverSettingsTimer(),
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
    try {
      const authorization = await boundAccountViewer(getRequest(), env as Partial<SessionEnv>, data.viewerId);
      if (!authorization) return { state: 'denied', status: 401, code: 'authentication_required' };
      if (!(env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN) return failure(null);
      const { kernelClient } = await import('../../kernel/client');
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

function thrownFailure(error: unknown): DetailFailure {
  const result = managedAccountsException(error, settingsMediaFailure);
  return detailFailure(
    result.status,
    { code: result.code, retryable: result.retryable, request_id: result.requestId },
    result.retryAfter ? { 'retry-after': result.retryAfter } : undefined,
  );
}

/** One native bounded read; signed cursors are opaque and only the selected feed is advanced. */
export async function loadManagedAccountDetail(
  client: KernelClient,
  authorization: string,
  input: DetailRequest,
  env: Parameters<typeof projectManagedAuthNavigation>[3] = {},
  signal?: AbortSignal,
): Promise<DetailResult> {
  try {
    const result = await withManagedReadDeadline(
      (signal) =>
        client.accounts({ accountId: input.accountId }).management.get({
          headers: { authorization, 'cache-control': 'no-store' },
          fetch: { cache: 'no-store', signal },
          query: input.cursor
            ? input.section === 'members'
              ? { membersCursor: input.cursor }
              : { operatorsCursor: input.cursor }
            : {},
        }),
      signal,
      serverSettingsTimer(),
    );
    if (result.error || !result.data)
      return { ok: false, failure: detailFailure(result.status, result.error?.value, result.headers) };
    const parsed = v.safeParse(managementSchema, result.data);
    if (!parsed.success || parsed.output.account.id.toLowerCase() !== input.accountId.toLowerCase())
      return { ok: false, failure: { status: 502, code: 'invalid_response', transient: false } };
    const { authActions, ...value } = parsed.output;
    if (value.members.state === 'denied') value.members = { state: 'denied', items: [], next: null };
    if (
      value.members.items.some((item) => item.account && item.account.id !== item.accountId) ||
      value.responsibilities?.items.some((item) => item.account && item.account.id !== item.accountId)
    )
      return { ok: false, failure: { status: 502, code: 'invalid_response', transient: false } };
    return {
      ok: true,
      viewerId: input.viewerId,
      value,
      authNavigation: projectManagedAuthNavigation(authActions, value, input.viewerId, env),
    };
  } catch (error) {
    return { ok: false, failure: thrownFailure(error) };
  }
}

export const readManagedAccountDetail = createServerFn({ method: 'GET' })
  .validator((input: unknown): DetailRequest =>
    v.parse(
      v.strictObject({
        viewerId: v.pipe(v.string(), v.minLength(1)),
        accountId: id,
        section: v.optional(v.picklist(['members', 'responsibilities'])),
        cursor: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
      }),
      input,
    ),
  )
  .handler(async ({ data }): Promise<DetailResult> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const { env } = await import('cloudflare:workers');
      const { prepareSession, sessionSubject, viewerCredential } = await import('../../session/request');
      const { kernelClient } = await import('../../kernel/client');
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      if (!authorization || sessionSubject(request) !== data.viewerId)
        return { ok: false, failure: detailFailure(401) };
      // account.read_management has public exposure. Native admission and current Access still run on every GET.
      return loadManagedAccountDetail(kernelClient(), authorization, data, env as Partial<SessionEnv>, request.signal);
    } catch (error) {
      return { ok: false, failure: thrownFailure(error) };
    }
  });

import { isNotFound, isRedirect } from '@tanstack/react-router';
import { createEditableProfileSource, nativeProfileFailure } from '../editable-profile-source';
import { profileReadFailure } from '../profile-failure';
import {
  boundedFailure,
  type AccountRenameContext,
  type AccountRenameFailure,
  type AccountRenameReadResult,
} from '../account-rename-data';
import type { AccountRenameNavigation, AccountRenameResult } from '../account-rename-actions';

export function accountRenameException(error: unknown): AccountRenameFailure {
  const result = managedAccountsException(error, settingsMediaFailure);
  return boundedFailure(
    profileReadFailure(error, settingsMediaFailure) ?? {
      status: result.status,
      ...(result.code ? { code: result.code } : {}),
      ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
    },
  );
}

const actionsResponse = v.strictObject({
  resources: v.tuple([
    v.strictObject({
      type: v.literal('access.account'),
      id: v.string(),
      viewerActions: v.array(v.strictObject({ action: v.string(), operations: v.array(v.string()) })),
    }),
  ]),
});

/** Compatibility view: context absence and absent capability still grant nothing. */
export async function loadAccountRenameRegion(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<AccountRenameContext | null> {
  return (await loadAccountRenameRegionResult(client, request, sessionEnv)).context;
}

/** One current session read plus the two exact-key reads, independently of preferences. */
export async function loadAccountRenameRegionResult(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<AccountRenameReadResult> {
  await withManagedReadDeadline(() => prepareSession(request, sessionEnv), request.signal, serverSettingsTimer());
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  return authorization && accountId
    ? readAccountRenameContextResult(client, authorization, accountId, request.signal)
    : { context: null };
}

export async function readAccountRenameContext(
  client: KernelClient,
  authorization: string,
  accountId: string,
): Promise<AccountRenameContext | null> {
  return (await readAccountRenameContextResult(client, authorization, accountId)).context;
}

/** Additive result seam retains both native failures without changing the original context fixtures. */
export async function readAccountRenameContextResult(
  client: KernelClient,
  authorization: string,
  accountId: string,
  signal?: AbortSignal,
): Promise<AccountRenameReadResult> {
  const [profileRead, actionsRead] = await Promise.allSettled([
    withManagedReadDeadline(
      (signal) => createEditableProfileSource(client).read(authorization, accountId, signal),
      signal,
      serverSettingsTimer(),
    ),
    withManagedReadDeadline(
      (signal) =>
        client.viewerActions.post(
          { resources: [{ type: 'access.account', id: accountId }] },
          { headers: { authorization, 'cache-control': 'no-store' }, fetch: { cache: 'no-store', signal } },
        ),
      signal,
      serverSettingsTimer(),
    ),
  ]);
  const failures: AccountRenameFailure[] = [];
  const profile = profileRead.status === 'fulfilled' ? profileRead.value.profile : null;
  if (profileRead.status === 'rejected') failures.push(accountRenameException(profileRead.reason));
  const result = actionsRead.status === 'fulfilled' ? actionsRead.value : null;
  if (actionsRead.status === 'rejected') failures.push(accountRenameException(actionsRead.reason));
  else if (result && (result.error || result.status !== 200))
    failures.push(boundedFailure(nativeProfileFailure(result.status, result.error?.value, result.headers)));
  const parsed = result && !result.error && result.status === 200 ? v.safeParse(actionsResponse, result.data) : null;
  const resource = parsed?.success ? parsed.output.resources[0] : null;
  return {
    context: profile
      ? {
          accountId: profile.id,
          handle: profile.handle,
          // Native discovery includes installed operation exposure and the current permission formula.
          available:
            profile.kind === 'actor' &&
            resource?.id === accountId &&
            resource.viewerActions.some(
              (entry) => entry.action === 'account:update' && entry.operations.includes('account.update'),
            ),
        }
      : null,
    ...(failures.length ? { failures } : {}),
  };
}
/** Compose deployment availability after the existing native current-capability read. */
export function accountRenameNavigation(
  env: Readonly<Partial<SessionEnv>>,
  context: AccountRenameContext | null,
): AccountRenameNavigation | null {
  if (!context) return null;
  return {
    ...context,
    href: context.available ? authManagementPageHref(env, '/account/rename') : null,
  };
}

/** Redirect and not-found remain Start/Router control flow, including after a failed private read. */
export function accountRenameControlFlow(error: unknown): void {
  if (isRedirect(error) || isNotFound(error)) throw error;
}

/** Module, request-helper and serialization faults stay in the same plain unavailable envelope. */
export function accountRenameSetupFailure(error: unknown): AccountRenameResult {
  accountRenameControlFlow(error);
  return { context: null, failures: [{ kind: 'unavailable', status: null } satisfies AccountRenameFailure] };
}

/** Server-function transport drops custom properties; only JSON-safe metadata crosses the boundary. */
export function serializeAccountRenameResult(result: AccountRenameResult): AccountRenameResult {
  return JSON.parse(JSON.stringify(result)) as AccountRenameResult;
}

/** Setup and native faults stay in this envelope; createServerFn only supplies the POST/CSRF boundary. */
export async function runAccountRenameHandler(): Promise<AccountRenameResult> {
  try {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('cache-control', 'private, no-store');
    const { env } = await import('cloudflare:workers');
    const { kernelClient } = await import('../../kernel/client');
    const sessionEnv = env as Partial<SessionEnv>;
    try {
      const result = await loadAccountRenameRegionResult(kernelClient(), getRequest(), sessionEnv);
      return serializeAccountRenameResult({
        ...result,
        context: accountRenameNavigation(sessionEnv, result.context),
      });
    } catch (error) {
      accountRenameControlFlow(error);
      return serializeAccountRenameResult({ context: null, failures: [accountRenameException(error)] });
    }
  } catch (error) {
    return serializeAccountRenameResult(accountRenameSetupFailure(error));
  }
}

/** Browser-only region read; POST uses the ordinary Origin and session CSRF checks. */
export const readAccountRename = createServerFn({ method: 'POST' }).handler(runAccountRenameHandler);
