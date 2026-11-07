import { withManagedReadDeadline } from './managed-read-deadline';
import { preferenceRetryDeadline, type SettingsAmbient } from './ports/ambient';
import type { ManagedReaderCurrent } from './managed-session-reader';
import { detailFailure } from './managed-account-failure';
import type {
  ManagementDetail,
  DetailFailure,
  DetailRead,
  DetailSection,
  DetailResult,
} from './managed-account-contract';
import type { ManagedAuthNavigation } from './managed-account-vocabulary';
export type {
  ManagementDetail,
  ManagementIdentity,
  DetailSection,
  DetailRequest,
  DetailFailure,
  DetailResult,
  DetailRead,
} from './managed-account-contract';
export { detailFailure } from './managed-account-failure';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

/** A URL selection opens detail only when the native navigation observation independently admits it. */
export function selectAdmittedManagedAccountTarget(
  requested: string | null | undefined,
  admitted: string | null | undefined,
): string | undefined {
  return typeof requested === 'string' && requested === admitted ? requested : undefined;
}

export function managedAccountsBackHref(href: string): string {
  const url = new URL(href, 'https://rezics.local');
  url.searchParams.delete('managedAccount');
  return `${url.pathname}${url.search}#account`;
}

type SectionState<T> = {
  page: T | undefined;
  cursor?: string | undefined;
  pending: boolean;
  failure?: DetailFailure | undefined;
};
export type DetailSnapshot = {
  retryAt?: number | undefined;
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
    private readonly ambient: SettingsAmbient,
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
    // All controls, including callbacks captured before the response, share this endpoint wait.
    if ((this.state.retryAt ?? 0) > this.ambient.now()) return;
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
        this.ambient.timer,
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
      // Observe once on receipt. A sibling reply cannot shorten an already observed wait.
      const retryAt = Math.max(
        this.state.retryAt ?? 0,
        preferenceRetryDeadline(failure.retryAfter, this.ambient.now()),
      );
      if ([401, 403, 404].includes(failure.status ?? 0) || !section) {
        if (!failure.transient) this.generation++;
        this.publish({
          ...(failure.transient ? this.state : empty()),
          retryAt,
          authNavigation: undefined,
          pending: false,
          failure,
        });
      } else
        this.publish({
          ...this.state,
          retryAt,
          // A failed older feed owns its feedback, not a newer observation's action advice.
          authNavigation: observation === this.actionObservation ? undefined : this.state.authNavigation,
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
    // The selected feed can settle independently; only the latest admitted read owns shared target identity and proof.
    const latestObservation = observation === this.actionObservation;
    this.publish({
      retryAt: this.state.retryAt,
      // Restrictions withdraw proof regardless of which admitted sibling supplied them.
      authNavigation: restricted ? undefined : latestObservation ? result.authNavigation : this.state.authNavigation,
      detail: latestObservation
        ? {
            account: detail.account,
            self: detail.self,
            role: detail.role,
            operator: detail.operator,
            operated: detail.relation !== null,
          }
        : this.state.detail,
      pending: false,
      members:
        !section || section === 'members' || detail.members.state === 'denied'
          ? { page: detail.members, cursor: section === 'members' ? cursor : undefined, pending: false }
          : restricted
            ? { ...this.state.members, pending: false }
            : this.state.members,
      responsibilities:
        !section || section === 'responsibilities' || detail.responsibilities === null
          ? {
              page: detail.responsibilities,
              cursor: section === 'responsibilities' ? cursor : undefined,
              pending: false,
            }
          : restricted
            ? { ...this.state.responsibilities, pending: false }
            : this.state.responsibilities,
    });
  }
}
