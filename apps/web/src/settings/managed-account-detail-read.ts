import { withManagedReadDeadline } from './managed-read-deadline';
import type { ManagedReaderCurrent } from './managed-session-reader';
import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import * as v from 'valibot';
import type { NativePreferenceFailure } from './preferences';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { projectManagedAuthNavigation, type ManagedAuthNavigation } from './managed-account-actions-read';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = v.pipe(v.string(), v.regex(uuidPattern));
const text = v.nullable(v.string());
const identity = v.strictObject({ id, kind: v.picklist(['actor', 'organization']), handle: text, displayName: text });
const role = v.picklist(['owner', 'member']);
const responsibilityPage = v.strictObject({
  items: v.pipe(
    v.array(
      v.strictObject({
        reservationId: id,
        accountId: id,
        account: v.nullable(identity),
        state: v.picklist(['current', 'reconciling']),
      }),
    ),
    v.maxLength(20),
  ),
  next: text,
});
// Local validation mirrors services/kernel/src/access/account-management.ts, accountManagementSchema.
const managementSchema = v.strictObject({
  account: identity,
  self: v.boolean(),
  role: v.nullable(role),
  operator: v.nullable(identity),
  relation: v.nullable(v.strictObject({ operatorAccountId: id, reservationId: id, version: v.string() })),
  members: v.strictObject({
    state: v.picklist(['ready', 'denied']),
    items: v.pipe(v.array(v.strictObject({ accountId: id, account: v.nullable(identity), role })), v.maxLength(20)),
    next: text,
  }),
  responsibilities: v.nullable(responsibilityPage),
  // Validate this optional dependency separately: a malformed action observation cannot hide read-only detail.
  authActions: v.optional(v.unknown()),
});
export type ManagementDetail = Omit<v.InferOutput<typeof managementSchema>, 'authActions'>;
export type ManagementIdentity = ManagementDetail['account'];
export type DetailSection = 'members' | 'responsibilities';
export type DetailRequest = {
  viewerId: string;
  accountId: string;
  section?: DetailSection | undefined;
  cursor?: string | undefined;
};
export type DetailFailure = NativePreferenceFailure & { transient: boolean };
export type DetailResult =
  | { ok: true; viewerId: string; value: ManagementDetail; authNavigation?: ManagedAuthNavigation }
  | { ok: false; failure: DetailFailure };
export type DetailRead = (input: DetailRequest, signal?: AbortSignal) => Promise<DetailResult>;

/** Absent and invalid selections differ, but invalid, missing and invisible targets share one failure view. */
export function managedAccountTarget(href: string): string | null | undefined {
  const params = new URL(href, 'https://rezics.local').searchParams;
  const values = params.getAll('managedAccount');
  return values.length === 0
    ? undefined
    : values.length === 1 && uuidPattern.test(values[0]!)
      ? values[0]!.toLowerCase()
      : null;
}

export function managedAccountsBackHref(href: string): string {
  const url = new URL(href, 'https://rezics.local');
  url.searchParams.delete('managedAccount');
  return `${url.pathname}${url.search}#account`;
}

export function detailFailure(status: number | null, body?: unknown, headers?: HeadersInit): DetailFailure {
  const code =
    body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
  const retryAfter = new Headers(headers).get('retry-after') ?? undefined;
  const retryable =
    body && typeof body === 'object' && 'retryable' in body && typeof body.retryable === 'boolean'
      ? body.retryable
      : undefined;
  const requestId =
    body && typeof body === 'object' && 'request_id' in body && typeof body.request_id === 'string'
      ? body.request_id
      : undefined;
  return {
    status,
    ...(code ? { code } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(requestId ? { requestId } : {}),
    transient:
      (status === null || status === 408 || status === 429 || (status >= 500 && status <= 599)) &&
      code !== 'platform_closed' &&
      retryable !== false,
  };
}

function thrownFailure(error: unknown): DetailFailure {
  if (isPlatformClosedError(error)) return detailFailure(403, { code: 'platform_closed' });
  if (error instanceof MediaProblem) return detailFailure(error.problem.status, error.problem, error.headers);
  return detailFailure(null);
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
      const [{ env }, { prepareSession, sessionSubject, viewerCredential }, { kernelClient }] = await Promise.all([
        import('cloudflare:workers'),
        import('../session/request'),
        import('../kernel/client'),
      ]);
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

type SectionState<T> = {
  page: T | undefined;
  cursor?: string | undefined;
  pending: boolean;
  failure?: DetailFailure | undefined;
};
export type DetailSnapshot = {
  detail?: (Pick<ManagementDetail, 'account' | 'self' | 'role' | 'operator'> & { operated: boolean }) | undefined;
  authNavigation?: ManagedAuthNavigation | undefined;
  pending: boolean;
  failure?: DetailFailure | undefined;
  members: SectionState<ManagementDetail['members']>;
  responsibilities: SectionState<ManagementDetail['responsibilities']>;
};
const empty = (): DetailSnapshot => ({
  pending: false,
  members: { page: undefined, pending: false },
  responsibilities: { page: undefined, pending: false },
});

/** A mounted immutable viewer/target owns at most one page per feed and one request per deliberate control. */
export class ManagedAccountReader {
  private state = empty();
  private generation = 0;
  private disposed = false;
  private readonly lifetime = new AbortController();
  private actionObservation = 0;
  private listeners = new Set<() => void>();
  constructor(
    readonly viewerId: string,
    readonly accountId: string,
    private read: DetailRead,
    readonly csrfToken: string | null = null,
    private readonly current: ManagedReaderCurrent = () => true,
  ) {}
  snapshot = () => {
    this.live();
    return this.state;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: DetailSnapshot) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  clear = () => {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.generation++;
    this.actionObservation++;
    this.publish(empty());
  };
  private live() {
    if (!this.disposed && !this.current()) this.clear();
    return !this.disposed;
  }
  async load(section?: DetailSection, cursor?: string) {
    if (!this.live()) return;
    if (this.state.pending || (section && this.state[section].pending)) return;
    if (!section && (this.state.members.pending || this.state.responsibilities.pending)) return;
    const generation = this.generation;
    const observation = ++this.actionObservation;
    this.publish(
      section
        ? {
            ...this.state,
            authNavigation: undefined,
            [section]: { ...this.state[section], pending: true, failure: undefined },
          }
        : { ...this.state, authNavigation: undefined, pending: true, failure: undefined },
    );
    let result: DetailResult;
    try {
      if (!this.live()) return;
      result = await withManagedReadDeadline(
        (signal) =>
          this.read(
            {
              viewerId: this.viewerId,
              accountId: this.accountId,
              ...(section ? { section } : {}),
              ...(cursor ? { cursor } : {}),
            },
            signal,
          ),
        this.lifetime.signal,
      );
    } catch {
      result = { ok: false, failure: detailFailure(null) };
    }
    if (!this.live() || generation !== this.generation) return;
    if (
      result.ok &&
      (result.viewerId !== this.viewerId || result.value.account.id.toLowerCase() !== this.accountId.toLowerCase())
    )
      result = { ok: false, failure: detailFailure(401) };
    if (!result.ok) {
      const { failure } = result;
      if ([401, 403, 404].includes(failure.status ?? 0) || !section) {
        if (!failure.transient) this.generation++;
        this.publish({
          ...(failure.transient ? this.state : empty()),
          authNavigation: undefined,
          pending: false,
          failure,
        });
      } else
        this.publish({
          ...this.state,
          authNavigation: undefined,
          [section]: {
            ...this.state[section],
            page: failure.transient ? this.state[section].page : undefined,
            pending: false,
            cursor,
            failure,
          },
        });
      return;
    }
    const detail = result.value;
    const restricted = detail.members.state === 'denied' || detail.responsibilities === null;
    // An authority loss observed by either feed invalidates other in-flight pages as well.
    if (restricted) this.generation++;
    this.publish({
      // An older feed reply cannot restore an entry after a newer read removed its proof.
      authNavigation: observation === this.actionObservation ? result.authNavigation : this.state.authNavigation,
      detail: {
        account: detail.account,
        self: detail.self,
        role: detail.role,
        operator: detail.operator,
        operated: detail.relation !== null,
      },
      pending: false,
      members:
        !section || section === 'members' || detail.members.state === 'denied'
          ? { page: detail.members, cursor: section === 'members' ? cursor : undefined, pending: false }
          : { ...this.state.members, pending: restricted ? false : this.state.members.pending },
      responsibilities:
        !section || section === 'responsibilities' || detail.responsibilities === null
          ? {
              page: detail.responsibilities,
              cursor: section === 'responsibilities' ? cursor : undefined,
              pending: false,
            }
          : { ...this.state.responsibilities, pending: restricted ? false : this.state.responsibilities.pending },
    });
  }
}
