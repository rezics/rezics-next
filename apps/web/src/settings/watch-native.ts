import type { KernelClient } from '@rezics/client';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { threadLocation } from '../threads/thread-href';

export type WatchKind = 'thread' | 'board';
export type ManagedWatch = Readonly<{
  subscriptionId: string;
  kind: WatchKind;
  revision: number;
  createdAt: string;
  /** Only the currently disclosed resource receives a title and localized destination. */
  target: Readonly<{ title: string; href: string }> | null;
}>;

export type WatchPage = Readonly<{ watches: readonly ManagedWatch[]; next: string | null }>;
export type WatchRead = { kind: 'page'; page: WatchPage } | { kind: 'unavailable' };
export type StopWatch = Readonly<{
  accountId: string;
  watchId: string;
  kind: WatchKind;
  expectedRevision: number;
  idempotencyKey: string;
}>;
export type StopWatchResult = { kind: 'removed' } | { kind: 'rejected' } | { kind: 'uncertain' };

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
  /** Dispatch the original removal episode through the current Settings session. */
  stop(input: StopWatch, csrfToken: string): Promise<StopWatchResult>;
}

/** The typed generated operation returns one closed management page for the selected kind. */
export async function readWatchInventoryNative(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  authorization: string,
  input: { kind: WatchKind; limit: 20; cursor: string | null },
  signal?: AbortSignal,
): Promise<WatchPage> {
  const result = await client.accounts({ accountId }).watches.get({
    query: { kind: input.kind, limit: input.limit, ...(input.cursor === null ? {} : { cursor: input.cursor }) },
    headers: { authorization },
    ...(signal ? { fetch: { signal } } : {}),
  });
  if (result.error || result.status !== 200) throw new Error('Native watch inventory read failed');
  return decodeWatchPage(result.data, input.kind);
}

/** Only the original removal episode and its native success receipt can confirm a stop. */
export async function removeWatchNative(
  client: Pick<KernelClient, 'accounts'>,
  authorization: string,
  input: StopWatch,
): Promise<StopWatchResult> {
  try {
    const result = await client
      .accounts({ accountId: input.accountId })
      .watches({ watchId: input.watchId })
      .delete(
        { expectedRevision: input.expectedRevision },
        {
          query: { kind: input.kind },
          headers: { 'idempotency-key': JSON.stringify(input.idempotencyKey) },
        },
      );
    if (!result.error && result.status === 200 && result.data?.removed === true) return { kind: 'removed' };
    if (result.status >= 400 && result.status < 500) return { kind: 'rejected' };
    return { kind: 'uncertain' };
  } catch {
    return { kind: 'uncertain' };
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

/** Reject malformed management pages and strip target identity from unavailable rows. */
export function decodeWatchPage(value: unknown, kind: WatchKind): WatchPage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['items', 'next']) ||
    !Array.isArray(value.items) ||
    value.items.length > 20 ||
    !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 4096))
  )
    throw new Error('Invalid native watch page');
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
    if (item.state === 'unavailable') {
      if (!exactKeys(item, ['id', 'kind', 'revision', 'createdAt', 'state']))
        throw new Error('Invalid native watch row');
      return {
        subscriptionId: item.id,
        kind,
        revision: item.revision as number,
        createdAt: item.createdAt,
        target: null,
      };
    }
    if (
      item.state !== 'available' ||
      !exactKeys(item, ['id', 'kind', 'revision', 'createdAt', 'state', 'resourceId', 'title']) ||
      !validId(item.resourceId) ||
      (item.title !== null && typeof item.title !== 'string')
    )
      throw new Error('Invalid native watch row');
    const title = item.title ?? m.threads_untitled();
    const href =
      kind === 'thread'
        ? threadLocation(getLocale(), { id: item.resourceId, title: item.title as string | null })
        : localizeHref(`/boards/${encodeURIComponent(item.resourceId)}`);
    return {
      subscriptionId: item.id,
      kind,
      revision: item.revision as number,
      createdAt: item.createdAt,
      target: { title, href },
    };
  });
  return { watches, next: value.next as string | null };
}

/** Optional unavailable binding remains a fixture for the honest missing-operation state. */
export const unavailableWatchManagement: WatchManagementIO = {
  read: async () => ({ kind: 'unavailable' }),
  stop: async () => ({ kind: 'uncertain' }),
};
