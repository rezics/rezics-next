import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useCallback, createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { sessionQuery } from '../session/query';

/** A credential belongs to one successful installed observation, never to retained query data alone. */
export class SettingsSessionOwner {
  private retired = false;
  private users = 0;
  private mounted = false;
  private release: (() => void) | undefined;
  private listeners = new Set<() => void>();
  readonly subject: string | null;
  readonly token: string | null;
  constructor(
    private client: QueryClient,
    token: string | null,
    subject?: string | null,
  ) {
    const query = client.getQueryState(sessionQuery.queryKey);
    this.subject = subject ?? query?.data?.subject ?? null;
    this.token = token;
    if (!this.matches()) this.retired = true;
  }
  private matches() {
    const query = this.client.getQueryState(sessionQuery.queryKey);
    return (
      query?.status === 'success' &&
      query.data?.state === 'signed-in' &&
      !!this.subject &&
      !!this.token &&
      query.data.subject === this.subject &&
      query.data.csrfToken === this.token
    );
  }
  isCurrent = () => {
    if (!this.retired && !this.matches()) this.retire();
    return !this.retired && (!this.mounted || this.users > 0);
  };
  credential = () => (this.isCurrent() ? this.token : null);
  snapshot = () => this.retired;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.release?.();
    this.release = undefined;
    this.listeners.forEach((listener) => listener());
  };
  /** Subscribe before any mounted private IO; StrictMode's immediate reconnect retains this observation. */
  mount = () => {
    this.users++;
    this.mounted = true;
    if (this.isCurrent() && !this.release) {
      this.release = this.client.getQueryCache().subscribe(({ query }) => {
        if (query.queryKey.length === 1 && query.queryKey[0] === sessionQuery.queryKey[0]) this.isCurrent();
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users--;
      queueMicrotask(() => {
        if (this.users === 0) this.retire();
      });
    };
  };
  async guard<T>(dispatch: (token: string) => Promise<T>): Promise<T> {
    const token = this.credential();
    if (!token) throw new Error('Settings viewer unavailable');
    const result = await dispatch(token);
    if (!this.isCurrent()) throw new Error('Settings viewer changed');
    return result;
  }
}

export const SettingsSessionContext = createContext<SettingsSessionOwner | null>(null);
const standaloneCurrent = () => true;
const unavailable = () => false;

/** Does not read the session transport. Standalone injected examples can omit a QueryClient entirely. */
export function useSettingsSessionOwner(token: string | null, subject?: string | null, standalone = false) {
  const client = useContext(QueryClientContext);
  const inherited = useContext(SettingsSessionContext);
  const [local] = useState(() =>
    !inherited && client && (!standalone || client.getQueryState(sessionQuery.queryKey))
      ? new SettingsSessionOwner(client, token, subject)
      : null,
  );
  const owner = inherited ?? local;
  useLayoutEffect(() => owner?.mount(), [owner]);
  useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.snapshot ?? unavailable, unavailable);
  return owner;
}

export function useSettingsCurrent(token: string | null, standalone = false) {
  const owner = useSettingsSessionOwner(token, undefined, standalone);
  return useSettingsLiveness(owner?.isCurrent ?? (standalone ? standaloneCurrent : unavailable));
}

/** Close an individual editor immediately during cleanup, and permanently after a real unmount. */
export function useSettingsLiveness(current: () => boolean) {
  const [lifetime] = useState(() => ({ active: true, retired: false, current }));
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
      queueMicrotask(() => {
        if (!lifetime.active) lifetime.retired = true;
      });
    };
  }, [lifetime]);
  return useCallback(() => lifetime.active && !lifetime.retired && lifetime.current(), [lifetime]);
}

/** Dispose after real teardown, without cancelling an in-flight operation during StrictMode effect replay. */
export function useSettingsDisposal(dispose: () => void) {
  const [lifetime] = useState(() => ({ users: 0 }));
  useLayoutEffect(() => {
    lifetime.users++;
    return () => {
      lifetime.users--;
      queueMicrotask(() => {
        if (lifetime.users === 0) dispose();
      });
    };
  }, [dispose, lifetime]);
}
