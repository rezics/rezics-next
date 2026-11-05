import type { KernelClient } from '@rezics/client';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import { threadLocation } from '../threads/thread-href';
import { settingsCommandKeyHeader } from './command-headers';

export type WatchKind = 'thread' | 'board';
export type WatchAdvice = 'available' | 'denied';
export type WatchViewer = Readonly<{ state: 'current'; accountId: string }>;
export type WatchActions = Readonly<{ remove: WatchAdvice }>;
export type WatchCommand = Readonly<{ watchId: string; kind: WatchKind; expectedRevision: number }>;
export type NativeWatchProblem = Readonly<{
  status: number | null;
  code: string | null;
  retryable?: boolean;
  retryAfter?: string;
  requestId?: string;
}>;
export type ManagedWatch = Readonly<{
  subscriptionId: string;
  kind: WatchKind;
  revision: number;
  createdAt: string;
  command: WatchCommand;
  remove: WatchAdvice;
  /** Only the currently disclosed resource receives a title and localized destination. */
  target: Readonly<{ title: string; href: string }> | null;
}>;

export type WatchPage = Readonly<{
  viewer: WatchViewer;
  actions: WatchActions;
  watches: readonly ManagedWatch[];
  next: string | null;
}>;
export type WatchRead =
  | { kind: 'page'; page: WatchPage }
  | { kind: 'unavailable'; problem: NativeWatchProblem }
  | { kind: 'denied'; problem: NativeWatchProblem }
  | { kind: 'invalid_cursor'; problem: NativeWatchProblem };
export type StopWatch = Readonly<{
  accountId: string;
  watchId: string;
  kind: WatchKind;
  expectedRevision: number;
  idempotencyKey: string;
}>;
/** Original removal episode together with the session credential that dispatched it. */
export type StopWatchIntent = Readonly<StopWatch & { credential: string }>;
export type StopWatchResult =
  | { kind: 'removed' }
  | { kind: 'rejected'; problem: NativeWatchProblem }
  | { kind: 'conflict'; problem: NativeWatchProblem }
  | { kind: 'denied'; problem: NativeWatchProblem }
  | { kind: 'uncertain'; problem: NativeWatchProblem };

export interface WatchManagementIO {
  read(
    input: Readonly<{
      accountId: string;
      kind: WatchKind;
      limit: number;
      cursor: string | null;
      signal: AbortSignal;
    }>,
  ): Promise<WatchRead>;
  /** Dispatch the original removal episode with the credential captured for that intent. */
  stop(input: StopWatch, csrfToken: string): Promise<StopWatchResult>;
}

export function watchProblem(status: number | null, body?: unknown, headers?: HeadersInit): NativeWatchProblem {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const retryAfter = new Headers(headers).get('retry-after');
  return {
    status,
    code: record && typeof record.code === 'string' ? record.code : null,
    ...(record && typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(record && typeof record.request_id === 'string' ? { requestId: record.request_id } : {}),
  };
}

function readFailure(
  status: number | null,
  body?: unknown,
  headers?: HeadersInit,
): Exclude<WatchRead, { kind: 'page' }> {
  const problem = watchProblem(status, body, headers);
  if (problem.code === 'invalid_cursor') return { kind: 'invalid_cursor', problem };
  if (status !== null && [401, 403, 404, 410].includes(status)) return { kind: 'denied', problem };
  return { kind: 'unavailable', problem };
}

function writeFailure(
  status: number | null,
  body?: unknown,
  headers?: HeadersInit,
): Exclude<StopWatchResult, { kind: 'removed' }> {
  const problem = watchProblem(status, body, headers);
  if (status === 409 || problem.code === 'conflict') return { kind: 'conflict', problem };
  if (status !== null && [401, 403, 404, 410].includes(status)) return { kind: 'denied', problem };
  if (status !== null && status >= 400 && status < 500) return { kind: 'rejected', problem };
  return { kind: 'uncertain', problem };
}

function failureFromException(error: unknown): { status: number | null; body?: unknown; headers?: HeadersInit } {
  if (isPlatformClosedError(error)) return { status: error.status, body: error.problem };
  if (error instanceof MediaProblem)
    return {
      status: error.problem.status,
      body: error.problem,
      ...(error.headers ? { headers: error.headers } : {}),
    };
  return { status: null };
}

/** The typed generated operation returns one closed management page for the selected kind. */
export async function readWatchInventoryNative(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  input: { kind: WatchKind; limit: 20; cursor: string | null },
  signal?: AbortSignal,
): Promise<WatchRead> {
  try {
    const result = await client.accounts({ accountId }).watches.get({
      query: { kind: input.kind, limit: input.limit, ...(input.cursor === null ? {} : { cursor: input.cursor }) },
      ...(signal ? { fetch: { signal } } : {}),
    });
    if (result.error || result.data === null || result.status !== 200)
      return readFailure(result.status, result.error?.value ?? result.data, result.headers);
    return { kind: 'page', page: decodeWatchPage(result.data, input.kind) };
  } catch (error) {
    const failure = failureFromException(error);
    return readFailure(failure.status, failure.body, failure.headers);
  }
}

/** Only the original removal episode and its native success receipt can confirm a stop. */
export async function removeWatchNative(
  client: Pick<KernelClient, 'accounts'>,
  input: StopWatch,
  authorization: string,
): Promise<StopWatchResult> {
  try {
    const result = await client
      .accounts({ accountId: input.accountId })
      .watches({ watchId: input.watchId })
      .delete(
        { expectedRevision: input.expectedRevision },
        {
          query: { kind: input.kind },
          headers: {
            authorization,
            'idempotency-key': settingsCommandKeyHeader(input.idempotencyKey),
          },
        },
      );
    if (!result.error && result.status === 200 && result.data?.removed === true) return { kind: 'removed' };
    return writeFailure(result.status, result.error?.value ?? result.data, result.headers);
  } catch (error) {
    const failure = failureFromException(error);
    return writeFailure(failure.status, failure.body, failure.headers);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\?#%]/.test(value) && value !== '.' && value !== '..';
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function decodeCommand(value: unknown, kind: WatchKind, watchId: string, revision: number): WatchCommand {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['watchId', 'kind', 'expectedRevision']) ||
    value.watchId !== watchId ||
    value.kind !== kind ||
    value.expectedRevision !== revision
  )
    throw new Error('Invalid native watch command');
  return { watchId, kind, expectedRevision: revision };
}

function decodeViewer(value: unknown): WatchViewer {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['state', 'accountId']) ||
    value.state !== 'current' ||
    !validId(value.accountId)
  )
    throw new Error('Invalid native watch viewer');
  return { state: 'current', accountId: value.accountId };
}

function decodeActions(value: unknown): WatchActions {
  if (!isRecord(value) || !exactKeys(value, ['remove']) || (value.remove !== 'available' && value.remove !== 'denied'))
    throw new Error('Invalid native watch actions');
  return { remove: value.remove };
}

/** Reject malformed management pages and strip target identity from unavailable rows. */
export function decodeWatchPage(value: unknown, kind: WatchKind): WatchPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 4096))
  )
    throw new Error('Invalid native watch page');
  const viewer = decodeViewer(value.viewer);
  const actions = decodeActions(value.actions);
  const watches = value.items.map((item): ManagedWatch => {
    if (
      !isRecord(item) ||
      item.kind !== kind ||
      !validId(item.id) ||
      !Number.isSafeInteger(item.revision) ||
      (item.revision as number) < 1 ||
      !validInstant(item.createdAt)
    )
      throw new Error('Invalid native watch row');
    const command = decodeCommand(item.command, kind, item.id, item.revision as number);
    const shared = {
      subscriptionId: item.id,
      kind,
      revision: item.revision as number,
      createdAt: item.createdAt,
      command,
      remove: actions.remove,
    };
    if (item.state === 'unavailable') {
      if (!exactKeys(item, ['id', 'kind', 'revision', 'createdAt', 'state', 'command']))
        throw new Error('Invalid native watch row');
      return { ...shared, target: null };
    }
    if (
      item.state !== 'available' ||
      !exactKeys(item, ['id', 'kind', 'revision', 'createdAt', 'state', 'resourceId', 'title', 'command']) ||
      !validId(item.resourceId) ||
      (item.title !== null && typeof item.title !== 'string')
    )
      throw new Error('Invalid native watch row');
    const title = item.title ?? m.threads_untitled();
    const href =
      kind === 'thread'
        ? threadLocation(getLocale(), { id: item.resourceId, title: item.title as string | null })
        : localizeHref(`/boards/${encodeURIComponent(item.resourceId)}`);
    return { ...shared, target: { title, href } };
  });
  return { viewer, actions, watches, next: value.next as string | null };
}

const missingOperation = watchProblem(null);
/** Fixture for the honest missing-operation state; production uses the generated inventory. */
export const unavailableWatchManagement: WatchManagementIO = {
  read: async () => ({ kind: 'unavailable', problem: missingOperation }),
  stop: async () => ({ kind: 'uncertain', problem: missingOperation }),
};
