import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { GatedOperation } from '../kernel/exposure';
import { sessionQuery } from '../session/query';
import { useLibraryWorkspaceAdmission, type LibraryWorkspaceAdmission } from './library-workspace-admission';

export type ManagementGuard = {
  isCurrent: (operation?: GatedOperation) => boolean;
  headers: (operation?: GatedOperation) => HeadersInit | null;
};

const readOperations: readonly GatedOperation[] = ['copy.list', 'copy.get', 'library_label.list'];

/** Local workflow custody. Cache notifications are synchronous, including A -> B -> A
 * updates that React may batch into a single render. Credentials are consumed, never captured.
 */
class ManagementCurrentOrigin {
  readonly id = crypto.randomUUID();
  private retired = false;
  private users = 0;
  private mounted = false;
  private release: (() => void) | undefined;
  private version = 0;
  private listeners = new Set<() => void>();
  private read?: { key: QueryKey; matches: (value: unknown) => boolean };
  private accepted = { retired: false };
  private acceptedValue: unknown;
  private rejectedAt = -1;
  private rejectedQuery: unknown;
  private operations = new Map<GatedOperation, { retired: boolean; version: number | undefined }>();
  private captured: ManagementGuard | undefined;
  constructor(
    private client: QueryClient,
    readonly subject: string | null,
    readonly address: string,
    private operation: GatedOperation,
    private browser: boolean,
    private admission: LibraryWorkspaceAdmission,
    readonly viewer: number,
  ) {}
  private admitted(operation: GatedOperation) {
    return this.admission.allowed(operation);
  }
  private credential() {
    const session = this.client.getQueryState(sessionQuery.queryKey);
    return session?.status === 'success' &&
      session.data?.state === 'signed-in' &&
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
    this.rejectedQuery = this.read
      ? this.client.getQueryCache().find({ queryKey: this.read.key, exact: true })
      : undefined;
    this.rejectedAt = this.read ? (this.client.getQueryState(this.read.key)?.dataUpdateCount ?? 0) : 0;
    this.changed();
  };
  private observe = () => {
    if (this.retired || !this.browser) return;
    const current = this.admission.read();
    if (!this.subject || current.subject !== this.subject || current.viewer !== this.viewer) {
      this.retire();
      return;
    }
    for (const [operation, lease] of this.operations) {
      if (!lease.retired && lease.version !== this.admission.dispatchVersion(operation)) {
        lease.retired = true;
        this.changed();
      }
    }
    if (this.read) {
      const query = this.client.getQueryState(this.read.key);
      if (!query || query.status !== 'success' || !this.read.matches(query.data)) this.rejectRead();
      else if (!this.accepted.retired && this.acceptedValue !== undefined && this.acceptedValue !== query.data) {
        this.accepted.retired = true;
        this.rejectedQuery = undefined;
        this.rejectedAt = -1;
        this.changed();
      }
    }
  };
  hasAuthority = () => this.browser && this.admission.read().subject === this.subject && this.admitted(this.operation);
  isCurrent = () => {
    this.observe();
    return this.alive() && this.admitted(this.operation);
  };
  private alive = () => this.browser && !this.retired && (!this.mounted || this.users > 0);
  capture = () => {
    const version = this.admission.dispatchVersion(this.operation);
    return () => this.isCurrent() && version === this.admission.dispatchVersion(this.operation);
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
    this.release ??= (() => {
      const cache = this.client.getQueryCache().subscribe(this.observe);
      const admission = this.admission.watch(this.observe);
      return () => {
        cache();
        admission();
      };
    })();
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
    if (!this.alive()) return null;
    const query = this.client.getQueryState(key);
    if (
      query?.status !== 'success' ||
      !matches(query.data) ||
      (this.accepted.retired &&
        this.client.getQueryCache().find({ queryKey: key, exact: true }) === this.rejectedQuery &&
        query.dataUpdateCount <= this.rejectedAt)
    )
      return null;
    if (this.accepted.retired) this.accepted = { retired: false };
    this.acceptedValue = query.data;
    for (const operation of operations) {
      if (!this.operations.has(operation) || this.operations.get(operation)!.retired) {
        this.operations.set(operation, { retired: false, version: this.admission.dispatchVersion(operation) });
        this.captured = undefined;
      }
    }
    if (!this.captured) {
      const accepted = this.accepted;
      const leases = new Map(this.operations);
      const isCurrent = (operation = this.operation) =>
        this.isCurrent() &&
        !leases.get(this.operation)?.retired &&
        this.admitted(operation) &&
        (readOperations.includes(operation) || !!this.credential()) &&
        !accepted.retired &&
        !!leases.get(operation) &&
        !leases.get(operation)!.retired;
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

const managementOperations = [
  'copy.list',
  'copy.get',
  'copy.create',
  'copy.update',
  'copy.delete',
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
] as const;

/** Address changes retire during render; authority changes also retire directly in the cache listener. */
export function useManagementCurrentOrigin(
  subject: string | null,
  address: string,
  operation: GatedOperation,
  browser: boolean,
  operations: readonly GatedOperation[] = managementOperations,
) {
  const client = useQueryClient();
  const { store, value } = useLibraryWorkspaceAdmission(operations);
  const previous = useRef<ManagementCurrentOrigin | null>(null);
  let origin = previous.current;
  if (
    !origin ||
    origin.subject !== subject ||
    origin.address !== address ||
    origin.viewer !== value.viewer ||
    (origin.isRetired() && origin.hasAuthority())
  ) {
    origin?.retire();
    origin = new ManagementCurrentOrigin(client, subject, address, operation, browser, store, value.viewer);
    previous.current = origin;
  }
  // Hydration replaces the non-authorizing server origin, even if its displayed subject agrees.
  const mode = useRef(browser);
  if (mode.current !== browser) {
    origin.retire();
    origin = new ManagementCurrentOrigin(client, subject, address, operation, browser, store, value.viewer);
    previous.current = origin;
    mode.current = browser;
  }
  useLayoutEffect(() => origin.mount(), [origin]);
  useSyncExternalStore(origin.subscribe, origin.snapshot, origin.snapshot);
  return origin;
}
