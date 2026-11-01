import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import { exposureQuery, sessionQuery } from '../session/query';

export type ManagementGuard = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
};

/** Local workflow custody. Cache notifications are synchronous, including A -> B -> A
 * updates that React may batch into a single render. Credentials are consumed, never captured.
 */
class ManagementCurrentOrigin {
  readonly id = crypto.randomUUID();
  private retired = false;
  private users = 0;
  private mounted = false;
  private release?: () => void;
  private version = 0;
  private listeners = new Set<() => void>();
  private read?: { key: QueryKey; matches: (value: unknown) => boolean };
  private accepted = { retired: false };
  private rejectedAt = -1;
  private operations = new Map<GatedOperation, { retired: boolean }>();
  private captured?: ManagementGuard;
  constructor(
    private client: QueryClient,
    readonly subject: string | null,
    readonly address: string,
    private operation: GatedOperation,
    private browser: boolean,
  ) {}
  private admitted(operation: GatedOperation) {
    const exposure = this.client.getQueryState(exposureQuery.queryKey);
    return exposure?.status === 'success' && operationIsAdmitted(operation, exposure.data);
  }
  private credential() {
    const session = this.client.getQueryState(sessionQuery.queryKey);
    return session?.status === 'success' &&
      session.data.state === 'signed-in' &&
      !!this.subject &&
      session.data.subject === this.subject &&
      !!session.data.csrfToken
      ? session.data.csrfToken
      : null;
  }
  private changed() {
    this.version++;
    this.captured = undefined;
    this.listeners.forEach((listener) => listener());
  }
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.changed();
  };
  rejectRead = () => {
    if (this.accepted.retired) return;
    this.accepted.retired = true;
    this.rejectedAt = this.read ? (this.client.getQueryState(this.read.key)?.dataUpdateCount ?? 0) : 0;
    this.changed();
  };
  private observe = () => {
    if (this.retired || !this.browser) return;
    if (!this.credential() || !this.admitted(this.operation)) {
      this.retire();
      return;
    }
    for (const [operation, lease] of this.operations) {
      if (!lease.retired && !this.admitted(operation)) {
        lease.retired = true;
        this.changed();
      }
    }
    if (this.read) {
      const query = this.client.getQueryState(this.read.key);
      if (!query || query.status === 'error' || (query.data !== undefined && !this.read.matches(query.data)))
        this.rejectRead();
    }
  };
  hasAuthority = () => this.browser && !!this.credential() && this.admitted(this.operation);
  isCurrent = () => {
    this.observe();
    return this.browser && !this.retired && (!this.mounted || this.users > 0);
  };
  isRetired = () => this.retired;
  snapshot = () => this.version;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  mount = () => {
    this.mounted = true;
    this.users++;
    this.observe();
    this.release ??= this.client.getQueryCache().subscribe(this.observe);
    return () => {
      this.users--;
      // Cleanup closes callbacks immediately; StrictMode may reconnect this same live object.
      // A retired object is never reactivated by layout.
      queueMicrotask(() => {
        if (this.users) return;
        this.retire();
        this.release?.();
        this.release = undefined;
      });
    };
  };
  accept(key: QueryKey, matches: (value: unknown) => boolean, operations: readonly GatedOperation[]) {
    this.read = { key, matches };
    this.observe();
    if (!this.isCurrent()) return null;
    const query = this.client.getQueryState(key);
    if (
      query?.status !== 'success' ||
      !matches(query.data) ||
      (this.accepted.retired && query.dataUpdateCount <= this.rejectedAt)
    )
      return null;
    if (this.accepted.retired) this.accepted = { retired: false };
    for (const operation of operations) {
      if (this.admitted(operation) && (!this.operations.has(operation) || this.operations.get(operation)!.retired)) {
        this.operations.set(operation, { retired: false });
        this.captured = undefined;
      }
    }
    if (!this.captured) {
      const accepted = this.accepted;
      const leases = new Map(this.operations);
      const isCurrent = (operation = this.operation) =>
        this.isCurrent() && !accepted.retired && !!leases.get(operation) && !leases.get(operation)!.retired;
      this.captured = {
        isCurrent,
        headers: (operation) => {
          if (!isCurrent(operation)) return null;
          const token = this.credential();
          return token ? { 'x-csrf-token': token } : null;
        },
      };
    }
    return this.captured;
  }
}

/** Address changes retire during render; authority changes also retire directly in the cache listener. */
export function useManagementCurrentOrigin(
  subject: string | null,
  address: string,
  operation: GatedOperation,
  browser: boolean,
) {
  const client = useQueryClient();
  const previous = useRef<ManagementCurrentOrigin | null>(null);
  let origin = previous.current;
  if (
    !origin ||
    origin.subject !== subject ||
    origin.address !== address ||
    (origin.isRetired() && origin.hasAuthority())
  ) {
    origin?.retire();
    origin = new ManagementCurrentOrigin(client, subject, address, operation, browser);
    previous.current = origin;
  }
  // Hydration replaces the non-authorizing server origin, even if its displayed subject agrees.
  const mode = useRef(browser);
  if (mode.current !== browser) {
    origin.retire();
    origin = new ManagementCurrentOrigin(client, subject, address, operation, browser);
    previous.current = origin;
    mode.current = browser;
  }
  useLayoutEffect(() => origin.mount(), [origin]);
  useSyncExternalStore(origin.subscribe, origin.snapshot, origin.snapshot);
  return origin;
}
