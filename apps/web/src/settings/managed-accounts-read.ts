import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedReaderCurrent } from './managed-session-reader';
import type { KernelClient } from '@rezics/client';
import * as v from 'valibot';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';

const id = v.pipe(v.string(), v.uuid());
const text = v.nullable(v.string());
const identity = v.strictObject({ id, kind: v.picklist(['actor', 'organization']), handle: text, displayName: text });
const navigation = v.variant('state', [
  v.strictObject({ state: v.literal('admitted') }),
  v.strictObject({ state: v.literal('unavailable') }),
  v.strictObject({ state: v.literal('concealed') }),
]);
const organization = v.strictObject({
  account: identity,
  role: v.picklist(['owner', 'member']),
  navigation: v.optional(navigation),
});
const responsibility = v.strictObject({
  reservationId: id,
  accountId: id,
  account: v.nullable(identity),
  state: v.picklist(['current', 'reconciling']),
  navigation: v.optional(navigation),
});
const viewer = v.strictObject({ state: v.literal('current'), account: identity });
// Native authority: access/account-management.ts managedAccountsSchema, 20 scanned entries per feed.
// Additive viewer/navigation stay optional until e9314e51 publishes generated closure.
const schema = v.strictObject({
  account: identity,
  viewer: v.optional(viewer),
  organizations: v.strictObject({
    state: v.picklist(['ready', 'preparing']),
    items: v.pipe(v.array(organization), v.maxLength(20)),
    next: text,
  }),
  responsibilities: v.strictObject({ items: v.pipe(v.array(responsibility), v.maxLength(20)), next: text }),
});
export type ManagedDirectoryNavigation = v.InferOutput<typeof navigation>;
export type ManagedIdentity = v.InferOutput<typeof identity>;
type DecodedPage = v.InferOutput<typeof schema>;
export type ManagedAccountsPage = {
  account: ManagedIdentity;
  viewer: { state: 'current'; account: ManagedIdentity };
  organizations: {
    state: 'ready' | 'preparing';
    items: Array<{ account: ManagedIdentity; role: 'owner' | 'member'; navigation: ManagedDirectoryNavigation }>;
    next: string | null;
  };
  responsibilities: {
    items: Array<{
      reservationId: string;
      accountId: string;
      account: ManagedIdentity | null;
      state: 'current' | 'reconciling';
      navigation: ManagedDirectoryNavigation;
    }>;
    next: string | null;
  };
};
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

/** First occurrence in the current native page; earlier pages are not retained to collapse duplicates. */
export function firstOccurrenceInCurrentPage<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function observedNavigation(
  value: ManagedDirectoryNavigation | undefined,
  visible: boolean,
): ManagedDirectoryNavigation | null {
  if (value?.state === 'admitted' && !visible) return null;
  if (value) return value;
  return { state: visible ? 'unavailable' : 'concealed' };
}

function projectPage(page: DecodedPage): ManagedAccountsPage | null {
  const viewer = page.viewer ?? { state: 'current' as const, account: page.account };
  if (viewer.account.id !== page.account.id || viewer.account.kind !== page.account.kind) return null;
  const organizations = [];
  for (const item of page.organizations.items) {
    const navigation = observedNavigation(item.navigation, true);
    if (!navigation) return null;
    organizations.push({ ...item, navigation });
  }
  const responsibilities = [];
  for (const item of page.responsibilities.items) {
    const visible = item.account !== null;
    const navigation = observedNavigation(item.navigation, visible);
    if (!navigation) return null;
    responsibilities.push({ ...item, navigation });
  }
  return {
    account: page.account,
    viewer,
    organizations: {
      ...page.organizations,
      items: firstOccurrenceInCurrentPage(organizations, (item) => item.account.id),
    },
    responsibilities: {
      ...page.responsibilities,
      items: firstOccurrenceInCurrentPage(responsibilities, (item) => item.reservationId),
    },
  };
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
    const page = projectPage(parsed.output);
    if (!page || page.account.id !== viewerId || page.account.kind !== 'actor' || page.viewer.account.id !== viewerId)
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

/** Only native admitted navigation yields a private destination; never a server-supplied URL. */
export function managedAccountDestination(
  settingsHref: string,
  navigation: ManagedDirectoryNavigation | undefined,
  account: ManagedIdentity | null,
): string | undefined {
  if (!account || navigation?.state !== 'admitted') return undefined;
  return managedAccountHref(settingsHref, account.id);
}

type Feed<T> = {
  items: T[];
  next: string | null;
  origin: boolean;
  busy: boolean;
  failure: ManagedAccountsFailure | null;
  restartable: boolean;
  failedCursors: ManagedAccountsCursors | null;
};
export type ManagedAccountsSnapshot = {
  account: ManagedIdentity | null;
  viewer: ManagedAccountsPage['viewer'] | null;
  loading: boolean;
  failure: ManagedAccountsFailure | null;
  organizations: Feed<ManagedAccountsPage['organizations']['items'][number]> & { state: 'ready' | 'preparing' };
  responsibilities: Feed<ManagedAccountsPage['responsibilities']['items'][number]>;
};
function empty(): ManagedAccountsSnapshot {
  return {
    account: null,
    viewer: null,
    loading: false,
    failure: null,
    organizations: {
      state: 'ready',
      items: [],
      next: null,
      origin: true,
      busy: false,
      failure: null,
      restartable: false,
      failedCursors: null,
    },
    responsibilities: {
      items: [],
      next: null,
      origin: true,
      busy: false,
      failure: null,
      restartable: false,
      failedCursors: null,
    },
  };
}

function feedFrom<T>(page: { items: T[]; next: string | null }, origin: boolean, key: (item: T) => string): Feed<T> {
  return {
    ...page,
    items: firstOccurrenceInCurrentPage(page.items, key),
    origin,
    busy: false,
    failure: null,
    restartable: false,
    failedCursors: null,
  };
}

/** One retained page per feed and one request per explicit feed action. Sibling payloads never replace each other. */
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
      if (
        result.ok &&
        (result.page.account.id !== this.viewerId ||
          result.page.account.kind !== 'actor' ||
          result.page.viewer.account.id !== this.viewerId)
      )
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
      viewer: page.viewer,
      loading: false,
      failure: null,
      organizations: {
        ...feedFrom(page.organizations, true, (item) => item.account.id),
        state: page.organizations.state,
        items:
          page.organizations.state === 'preparing'
            ? []
            : firstOccurrenceInCurrentPage(page.organizations.items, (item) => item.account.id),
      },
      responsibilities: feedFrom(page.responsibilities, true, (item) => item.reservationId),
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
    const retry = !firstPage && before[feed].failure !== null;
    const origin = before[feed].origin;
    if (firstPage) {
      if (preparing) return;
      if (!before[feed].restartable && origin) return;
    } else if (!retry && before[feed].next === null && !preparing) return;
    const cursors: ManagedAccountsCursors =
      firstPage || preparing || (retry && before[feed].failedCursors !== null && Object.keys(before[feed].failedCursors).length === 0)
        ? {}
        : retry && before[feed].failedCursors
          ? before[feed].failedCursors
          : feed === 'organizations'
            ? { organizationsCursor: before[feed].next! }
            : { operatorsCursor: before[feed].next! };
    const epoch = this.epoch;
    this.publish({ ...before, [feed]: { ...before[feed], busy: true } });
    const result = await this.request(cursors);
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
            failedCursors: cursors,
            restartable:
              before[feed].restartable ||
              (!preparing && (result.status === 400 || result.status === 409) && (firstPage || before[feed].next !== null)),
          },
        });
      return;
    }
    const current = this.value;
    const replaced = firstPage || Object.keys(cursors).length === 0;
    const account =
      current.account && result.page.account.id === current.account.id ? current.account : result.page.account;
    const viewer =
      current.viewer && result.page.viewer.account.id === current.viewer.account.id
        ? current.viewer
        : result.page.viewer;
    if (feed === 'organizations') {
      const next = result.page.organizations;
      this.publish({
        ...current,
        account,
        viewer,
        organizations: {
          ...feedFrom(
            {
              items: next.state === 'preparing' ? [] : next.items,
              next: next.next,
            },
            replaced,
            (item) => item.account.id,
          ),
          state: next.state,
        },
      });
    } else {
      const next = result.page.responsibilities;
      this.publish({
        ...current,
        account,
        viewer,
        responsibilities: feedFrom(next, replaced, (item) => item.reservationId),
      });
    }
  }
}
