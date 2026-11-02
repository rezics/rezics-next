import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedReaderCurrent } from './managed-session-reader';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';

const id = v.pipe(v.string(), v.uuid());
const text = v.nullable(v.string());
const identity = v.strictObject({ id, kind: v.picklist(['actor', 'organization']), handle: text, displayName: text });
const organization = v.strictObject({ account: identity, role: v.picklist(['owner', 'member']) });
const responsibility = v.strictObject({
  reservationId: id,
  accountId: id,
  account: v.nullable(identity),
  state: v.picklist(['current', 'reconciling']),
});
// Native authority: access/account-management.ts managedAccountsSchema, 20 scanned entries per feed.
const schema = v.strictObject({
  account: identity,
  organizations: v.strictObject({
    state: v.picklist(['ready', 'preparing']),
    items: v.pipe(v.array(organization), v.maxLength(20)),
    next: text,
  }),
  responsibilities: v.strictObject({ items: v.pipe(v.array(responsibility), v.maxLength(20)), next: text }),
});
export type ManagedAccountsPage = v.InferOutput<typeof schema>;
export type ManagedIdentity = ManagedAccountsPage['account'];
export type ManagedAccountsCursors = { organizationsCursor?: string; operatorsCursor?: string };
export type ManagedAccountsFailure = {
  ok: false;
  kind: 'denied' | 'unavailable';
  status: number | null;
  code: string | null;
  retryAfter?: string;
  retryable?: boolean;
  requestId?: string;
};
export type ManagedAccountsResult = { ok: true; page: ManagedAccountsPage } | ManagedAccountsFailure;
export type ManagedAccountsIO = (
  cursors: ManagedAccountsCursors,
  signal?: AbortSignal,
) => Promise<ManagedAccountsResult>;
export type ManagedFeed = 'organizations' | 'responsibilities';

export function parseManagedAccountsCursors(value: unknown): ManagedAccountsCursors {
  const parsed = v.parse(
    v.strictObject({
      organizationsCursor: v.optional(v.pipe(v.string(), v.maxLength(4096))),
      operatorsCursor: v.optional(v.pipe(v.string(), v.maxLength(4096))),
    }),
    value,
  );
  return {
    ...(parsed.organizationsCursor === undefined ? {} : { organizationsCursor: parsed.organizationsCursor }),
    ...(parsed.operatorsCursor === undefined ? {} : { operatorsCursor: parsed.operatorsCursor }),
  };
}

export function managedAccountsFailure(
  status: number | null,
  body?: unknown,
  headers?: HeadersInit,
): ManagedAccountsFailure {
  const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : null;
  const retryAfter = new Headers(headers).get('retry-after');
  const retryable =
    body && typeof body === 'object' && 'retryable' in body && typeof body.retryable === 'boolean'
      ? body.retryable
      : undefined;
  const requestId =
    body && typeof body === 'object' && 'request_id' in body && typeof body.request_id === 'string'
      ? body.request_id
      : undefined;
  return {
    ok: false,
    kind: status !== null && [401, 403, 404, 410].includes(status) ? 'denied' : 'unavailable',
    status,
    code,
    ...(retryAfter ? { retryAfter } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(requestId ? { requestId } : {}),
  };
}
export function managedAccountsException(error: unknown): ManagedAccountsFailure {
  if (isPlatformClosedError(error)) return managedAccountsFailure(error.status, error.problem);
  if (error instanceof MediaProblem) return managedAccountsFailure(error.problem.status, error.problem, error.headers);
  return managedAccountsFailure(null);
}

/** The existing server transport keeps credentials private; no target/operated identity is accepted. */
export async function loadManagedAccounts(
  client: KernelClient,
  authorization: string,
  viewerId: string,
  cursors: ManagedAccountsCursors,
  signal?: AbortSignal,
): Promise<ManagedAccountsResult> {
  try {
    const result = await withManagedReadDeadline(
      (signal) =>
        client.me.managedAccounts.get({
          query: parseManagedAccountsCursors(cursors),
          headers: { authorization, 'cache-control': 'no-store' },
          fetch: { cache: 'no-store', signal },
        }),
      signal,
    );
    if (result.error) return managedAccountsFailure(result.status, result.error.value, result.headers);
    const parsed = v.safeParse(schema, result.data);
    if (!parsed.success) return managedAccountsFailure(result.status, undefined, result.headers);
    const page = parsed.output;
    if (page.account.id !== viewerId || page.account.kind !== 'actor')
      return { ...managedAccountsFailure(result.status, undefined, result.headers), kind: 'denied' };
    if (
      page.organizations.items.some((item) => item.account.kind !== 'organization') ||
      page.responsibilities.items.some((item) => item.account && item.account.id !== item.accountId)
    )
      return managedAccountsFailure(result.status, undefined, result.headers);
    return { ok: true, page };
  } catch (error) {
    return managedAccountsException(error);
  }
}

/** Keep the settings route, locale and query context; inventory links never import the detail surface. */
export function managedAccountHref(settingsHref: string, accountId: string): string {
  const url = new URL(settingsHref, 'https://rezics.local');
  url.searchParams.set('managedAccount', accountId);
  url.hash = 'account';
  return `${url.pathname}${url.search}${url.hash}`;
}

type Feed<T> = {
  items: T[];
  next: string | null;
  busy: boolean;
  failure: ManagedAccountsFailure | null;
  restartable: boolean;
};
export type ManagedAccountsSnapshot = {
  account: ManagedIdentity | null;
  loading: boolean;
  failure: ManagedAccountsFailure | null;
  organizations: Feed<ManagedAccountsPage['organizations']['items'][number]> & { state: 'ready' | 'preparing' };
  responsibilities: Feed<ManagedAccountsPage['responsibilities']['items'][number]>;
};
function empty(): ManagedAccountsSnapshot {
  return {
    account: null,
    loading: false,
    failure: null,
    organizations: { state: 'ready', items: [], next: null, busy: false, failure: null, restartable: false },
    responsibilities: { items: [], next: null, busy: false, failure: null, restartable: false },
  };
}
function append<T>(before: T[], after: T[], key: (item: T) => string): T[] {
  return [...new Map([...before, ...after].map((item) => [key(item), item])).values()];
}

/** One initial page and one request per explicit feed action. Sibling payloads never advance each other's cursor. */
export class ManagedAccountsInventory {
  private value = empty();
  private epoch = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private loadingEpoch = -1;
  private listeners = new Set<() => void>();
  constructor(
    private readonly viewerId: string,
    private readonly read: ManagedAccountsIO,
    private readonly current: ManagedReaderCurrent = () => true,
  ) {}
  snapshot = () => {
    this.live();
    return this.value;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: ManagedAccountsSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.epoch++;
    this.publish(empty());
  };
  private live() {
    if (!this.disposed && !this.current()) this.dispose();
    return !this.disposed;
  }
  private async request(cursors: ManagedAccountsCursors): Promise<ManagedAccountsResult> {
    try {
      if (!this.live()) return managedAccountsFailure(null);
      const result = await withManagedReadDeadline((signal) => this.read(cursors, signal), this.lifetime.signal);
      if (result.ok && (result.page.account.id !== this.viewerId || result.page.account.kind !== 'actor'))
        return { ok: false, kind: 'denied', status: null, code: null };
      return result;
    } catch (error) {
      return managedAccountsException(error);
    }
  }
  private deny(failure: ManagedAccountsFailure) {
    this.epoch++;
    this.publish({ ...empty(), failure });
  }
  async load() {
    if (!this.live()) return;
    if (this.value.loading && this.loadingEpoch === this.epoch) return;
    const epoch = ++this.epoch;
    this.loadingEpoch = epoch;
    this.publish({ ...empty(), loading: true });
    const result = await this.request({});
    if (!this.live() || epoch !== this.epoch) return;
    if (!result.ok) {
      this.deny(result);
      return;
    }
    const { page } = result;
    this.publish({
      account: page.account,
      loading: false,
      failure: null,
      organizations: {
        ...page.organizations,
        items: page.organizations.state === 'preparing' ? [] : page.organizations.items,
        busy: false,
        failure: null,
        restartable: false,
      },
      responsibilities: { ...page.responsibilities, busy: false, failure: null, restartable: false },
    });
  }
  async more(feed: ManagedFeed) {
    return this.readFeed(feed, false);
  }
  async firstPage(feed: ManagedFeed) {
    return this.readFeed(feed, true);
  }
  private async readFeed(feed: ManagedFeed, firstPage: boolean) {
    if (!this.live()) return;
    const before = this.value;
    if (!before.account || before.loading || before[feed].busy) return;
    const preparing = feed === 'organizations' && before.organizations.state === 'preparing';
    const cursor = before[feed].next;
    if (cursor === null && !preparing) return;
    if (firstPage && (preparing || cursor === null || !before[feed].restartable)) return;
    const epoch = this.epoch;
    this.publish({ ...before, [feed]: { ...before[feed], busy: true } });
    const result = await this.request(
      firstPage || cursor === null
        ? {}
        : feed === 'organizations'
          ? { organizationsCursor: cursor }
          : { operatorsCursor: cursor },
    );
    if (!this.live() || epoch !== this.epoch) return;
    if (!result.ok) {
      if (result.kind === 'denied') this.deny(result);
      else
        this.publish({
          ...this.value,
          [feed]: {
            ...this.value[feed],
            busy: false,
            failure: result,
            restartable:
              before[feed].restartable ||
              (!preparing && cursor !== null && (result.status === 400 || result.status === 409)),
          },
        });
      return;
    }
    const current = this.value;
    if (feed === 'organizations') {
      const next = result.page.organizations;
      this.publish({
        ...current,
        account: firstPage ? current.account : result.page.account,
        organizations: {
          ...next,
          items:
            next.state === 'preparing'
              ? []
              : firstPage
                ? next.items
                : append(preparing ? [] : current.organizations.items, next.items, (item) => item.account.id),
          busy: false,
          failure: null,
          restartable: false,
        },
      });
    } else {
      const next = result.page.responsibilities;
      this.publish({
        ...current,
        account: firstPage ? current.account : result.page.account,
        responsibilities: {
          ...next,
          items: firstPage
            ? next.items
            : append(current.responsibilities.items, next.items, (item) => item.reservationId),
          busy: false,
          failure: null,
          restartable: false,
        },
      });
    }
  }
}
