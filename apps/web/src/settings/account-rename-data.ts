import { withManagedReadDeadline } from './managed-read-deadline';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { createEditableProfileSource, nativeProfileFailure, profileReadFailure } from './editable-profile-source';
import type { NativePreferenceFailure } from './preferences';

export type AccountRenameContext = {
  accountId: string;
  handle: string | null;
  available: boolean;
};

export type AccountRenameFailure = NativePreferenceFailure & { kind: 'failed' | 'denied' | 'unavailable' };
/** Plain, bounded metadata crosses the server-function boundary, never custom Error properties. */
export type AccountRenameReadResult<T = AccountRenameContext> = {
  context: T | null;
  failures?: AccountRenameFailure[];
};

function boundedFailure(failure: NativePreferenceFailure): AccountRenameFailure {
  const status = failure.status;
  const text = (value: string | undefined, limit: number) => (value && value.length <= limit ? value : undefined);
  const code = text(failure.code, 128);
  const requestId = text(failure.requestId, 128);
  const retryAfter = text(failure.retryAfter, 128);
  return {
    status,
    kind:
      code === 'platform_closed' || status === 404 || status === 410 || status === 501
        ? 'unavailable'
        : status === 401 || status === 403
          ? 'denied'
          : 'failed',
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(typeof failure.retryable === 'boolean' ? { retryable: failure.retryable } : {}),
  };
}

export function accountRenameException(error: unknown): AccountRenameFailure {
  if (isPlatformClosedError(error)) return boundedFailure(nativeProfileFailure(error.status, error.problem));
  return boundedFailure(profileReadFailure(error) ?? { status: null });
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
  await prepareSession(request, sessionEnv);
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
    ),
    withManagedReadDeadline(
      (signal) =>
        client.viewerActions.post(
          { resources: [{ type: 'access.account', id: accountId }] },
          { headers: { authorization, 'cache-control': 'no-store' }, fetch: { cache: 'no-store', signal } },
        ),
      signal,
    ),
  ]);
  const failures: AccountRenameFailure[] = [];
  const profile = profileRead.status === 'fulfilled' ? profileRead.value : null;
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
