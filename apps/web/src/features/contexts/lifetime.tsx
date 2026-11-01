import { createContext, useContext, useLayoutEffect, useState } from 'react';
import { CancelledError, type QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../../session/query';

type SessionData = { state?: string; subject?: string | null; csrfToken?: string | null };
export type ContextAdmission = {
  readonly id: string;
  readonly reader: string;
  readonly csrfToken: string;
  readonly query: object;
  readonly updates: number;
  readonly updatedAt: number;
};

/** Observe successful session admissions, including equal data and batched A-B-A updates. */
export class ContextAdmissions {
  private value: ContextAdmission | null = null;
  constructor(private readonly client: QueryClient) {}

  snapshot = (): ContextAdmission | null => {
    const query = this.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    const state = query?.state;
    const data = state?.data as SessionData | undefined;
    if (!query || state?.status !== 'success' || data?.state !== 'signed-in' || !data.subject || !data.csrfToken) {
      this.value = null;
      return null;
    }
    if (
      this.value?.query !== query ||
      this.value.updates !== state.dataUpdateCount ||
      this.value.updatedAt !== state.dataUpdatedAt ||
      this.value.reader !== data.subject ||
      this.value.csrfToken !== data.csrfToken
    )
      this.value = {
        id: crypto.randomUUID(),
        reader: data.subject,
        csrfToken: data.csrfToken,
        query,
        updates: state.dataUpdateCount,
        updatedAt: state.dataUpdatedAt,
      };
    return this.value;
  };

  subscribe = (listener: () => void) => this.client.getQueryCache().subscribe(listener);
  current = (admission: ContextAdmission) => this.snapshot() === admission;
}

/** One original visit owns its cache, continuations, pending work and retained callbacks. */
export class ContextVisit {
  readonly key: readonly unknown[];
  private controller = new AbortController();
  private retired = false;
  private readSequence = 0;
  session: string | undefined;

  constructor(
    private readonly client: QueryClient,
    private readonly admissions: ContextAdmissions,
    readonly admission: ContextAdmission,
    key: readonly unknown[],
  ) {
    // Only a random, token-free visit identity enters the private query key.
    this.key = [...key, crypto.randomUUID()];
  }

  live = (): boolean => {
    if (!this.retired && !this.admissions.current(this.admission)) this.retire();
    return !this.retired;
  };

  assertCurrent = () => {
    if (!this.live()) throw new CancelledError({ silent: true });
  };

  get signal() {
    return this.controller.signal;
  }
  get headers() {
    return { 'X-Context-Reader': this.admission.reader, 'X-CSRF-Token': this.admission.csrfToken };
  }

  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.session = undefined;
    this.readSequence++;
    this.controller.abort();
    void this.client.cancelQueries({ queryKey: this.key, exact: true });
    this.client.removeQueries({ queryKey: this.key, exact: true });
  };

  /** Cancellation invalidates settlement even when the transport ignores its signal. */
  async read<T>(
    signal: AbortSignal,
    request: (signal: AbortSignal) => Promise<T>,
    accept?: (result: T) => void,
  ): Promise<T> {
    this.assertCurrent();
    const sequence = ++this.readSequence;
    const combined = AbortSignal.any([signal, this.signal]);
    const assert = () => {
      this.assertCurrent();
      if (combined.aborted || sequence !== this.readSequence) throw new CancelledError({ silent: true });
    };
    assert();
    try {
      const result = await request(combined);
      assert();
      accept?.(result);
      return result;
    } catch (error) {
      assert();
      throw error;
    }
  }
}

export function useContextVisit(
  client: QueryClient,
  admissions: ContextAdmissions,
  admission: ContextAdmission,
  key: readonly unknown[],
) {
  const [visit, setVisit] = useState(() => new ContextVisit(client, admissions, admission, key));
  useLayoutEffect(() => {
    // Strict Mode effect replay starts a new visit; it never revives old callbacks.
    if (!visit.live()) {
      if (admissions.current(admission)) setVisit(new ContextVisit(client, admissions, admission, key));
      return;
    }
    const stop = admissions.subscribe(() => {
      visit.live();
    });
    return () => {
      stop();
      visit.retire();
    };
  }, [visit, client, admissions, admission]);
  return visit;
}

const fixtureCurrent = () => true;
export const ContextWork = createContext<() => boolean>(fixtureCurrent);
export const useContextCurrent = () => useContext(ContextWork);
