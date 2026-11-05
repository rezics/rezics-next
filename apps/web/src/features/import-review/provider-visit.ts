import { useLayoutEffect, useState } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../../session/query';

export type ProviderReader = { subject: string; csrfToken: string | null };
export type ProviderEnvelope<T> = { reader: ProviderReader | null; result: T };
export type ProviderAdmission = ProviderReader & {
  readonly id: string;
  readonly query: object;
  readonly updates: number;
};

/** Observe the actual Query, including equal committed successes and synchronous A-B-A notifications. */
export class ProviderSessionSource {
  private value: ProviderAdmission | null = null;
  private timestamp = 0;
  private retired = false;
  private listeners = new Set<() => void>();
  private stop: (() => void) | undefined;
  constructor(readonly client: QueryClient) {}
  snapshot = (): ProviderAdmission | null => {
    if (this.retired) return null;
    const query = this.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    const data = query?.state.data as
      | { state?: string; subject?: string | null; csrfToken?: string | null }
      | undefined;
    if (!query || data?.state !== 'signed-in' || !data.subject) return (this.value = null);
    // Fetch/error/invalidation notifications alone do not destroy an already healthy admission.
    if (!this.value && query.state.status !== 'success') return null;
    if (
      this.value?.query !== query ||
      this.value.updates !== query.state.dataUpdateCount ||
      this.timestamp !== query.state.dataUpdatedAt ||
      this.value.subject !== data.subject ||
      this.value.csrfToken !== (data.csrfToken ?? null)
    ) {
      this.timestamp = query.state.dataUpdatedAt;
      this.value = Object.freeze({
        id: crypto.randomUUID(),
        query,
        updates: query.state.dataUpdateCount,
        subject: data.subject,
        csrfToken: data.csrfToken ?? null,
      });
    }
    return this.value;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.stop)
      this.stop = this.client.getQueryCache().subscribe(() => {
        const previous = this.value;
        const next = this.snapshot();
        if (previous !== next) for (const notify of this.listeners) notify();
      });
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.stop?.();
        this.stop = undefined;
      }
    };
  };
  current = (admission: ProviderAdmission) => !this.retired && this.snapshot() === admission;
  retire = () => {
    this.retired = true;
    this.value = null;
    this.stop?.();
    this.stop = undefined;
  };
}

const sessionSources = new WeakMap<QueryClient, ProviderSessionSource>();

/** Keep the actual session Query observation stable across SPA route visits. */
export function providerSessionSource(client: QueryClient): ProviderSessionSource {
  let source = sessionSources.get(client);
  if (!source) {
    source = new ProviderSessionSource(client);
    sessionSources.set(client, source);
  }
  return source;
}

export const providerAlwaysCurrent = () => true;

/** Every callback retains this original object. Retirement is monotonic, even after scope ABA. */
export class ProviderVisit {
  private retired = false;
  readonly id = crypto.randomUUID();
  constructor(private readonly owner: () => boolean = providerAlwaysCurrent) {}
  live = (): boolean => {
    if (!this.retired && !this.owner()) this.retired = true;
    return !this.retired;
  };
  retire = () => {
    this.retired = true;
  };
  assert = () => {
    if (!this.live()) throw new Error('Retired provider visit');
  };
}

/** Render-time replacement closes the gap before layout cleanup; effect replay creates fresh custody. */
export function useProviderVisit(owner = providerAlwaysCurrent, identity: unknown = owner): ProviderVisit {
  const [state, setState] = useState(() => ({ owner, identity, visit: new ProviderVisit(owner) }));
  let active = state;
  if (state.owner !== owner || state.identity !== identity) {
    state.visit.retire();
    active = { owner, identity, visit: new ProviderVisit(owner) };
    setState(active);
  }
  const visit = active.visit;
  useLayoutEffect(() => {
    if (!visit.live() && owner()) setState({ owner, identity, visit: new ProviderVisit(owner) });
    return () => visit.retire();
  }, [visit, owner, identity]);
  return visit;
}

export function providerReaderMatches(actual: ProviderReader | null, expected: ProviderReader): boolean {
  return (
    !!actual &&
    actual.subject === expected.subject &&
    (expected.csrfToken === null || actual.csrfToken === expected.csrfToken)
  );
}
