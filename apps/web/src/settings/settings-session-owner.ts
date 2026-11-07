import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useCallback, createContext, useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { productionSettingsShellPort } from './adapters/shell';

/** Read custody and write credentials belong to one successful installed observation, never to retained query data alone. */
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
    const query = productionSettingsShellPort.sessionQueryState(client);
    this.subject = subject ?? query?.data?.subject ?? null;
    this.token = token;
    if (!this.matches()) this.retired = true;
  }
  private matches() {
    const query = productionSettingsShellPort.sessionQueryState(this.client);
    return (
      query?.status === 'success' &&
      query.data?.state === 'signed-in' &&
      !!this.subject &&
      query.data.subject === this.subject &&
      query.data.csrfToken === this.token
    );
  }
  /** Successful identity permits reads even when this observation has no write credential. */
  readCurrent = () => {
    if (!this.retired && !this.matches()) this.retire();
    return !this.retired && (!this.mounted || this.users > 0);
  };
  /** Preserve the token-requiring writer contract for existing callers. */
  isCurrent = () => this.readCurrent() && !!this.token;
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
    if (this.readCurrent() && !this.release) {
      this.release = this.client.getQueryCache().subscribe(({ query, type }) => {
        if (!productionSettingsShellPort.isSessionQuery(query.queryKey)) return;
        if (type === 'removed') this.retire();
        else this.readCurrent();
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
  async guardRead<T>(dispatch: () => Promise<T>): Promise<T> {
    if (!this.readCurrent()) throw new Error('Settings viewer unavailable');
    const result = await dispatch();
    if (!this.readCurrent()) throw new Error('Settings viewer changed');
    return result;
  }
  async guard<T>(dispatch: (token: string) => Promise<T>): Promise<T> {
    const token = this.credential();
    if (!token) throw new Error('Settings viewer unavailable');
    const result = await dispatch(token);
    if (this.credential() !== token) throw new Error('Settings viewer changed');
    return result;
  }
}

export const SettingsSessionContext = createContext<SettingsSessionOwner | null>(null);
const standaloneCurrent = () => true;
const unavailable = () => false;

/** Does not read the session transport. A present QueryClient always requires an installed observation. */
export function useSettingsSessionOwner(
  token: string | null | undefined,
  subject?: string | null,
  _standalone = false,
) {
  const client = useContext(QueryClientContext);
  const inherited = useContext(SettingsSessionContext);
  const [local] = useState(() =>
    !inherited && client
      ? new SettingsSessionOwner(
          client,
          token === undefined ? (productionSettingsShellPort.sessionQueryData(client)?.csrfToken ?? null) : token,
          subject,
        )
      : null,
  );
  const owner = inherited ?? local;
  useLayoutEffect(() => owner?.mount(), [owner]);
  useSyncExternalStore(owner?.subscribe ?? (() => () => {}), owner?.snapshot ?? unavailable, unavailable);
  return owner;
}

export function useSettingsCurrent(token: string | null, standalone = false) {
  const owner = useSettingsSessionOwner(token, undefined, standalone);
  return useSettingsLiveness(
    owner ? () => owner.token === token && owner.isCurrent() : standalone ? standaloneCurrent : unavailable,
  );
}

/** Read-only custody never supplies mutation authority to existing writer callers. */
export function useSettingsReadCurrent(token: string | null, standalone = false) {
  const owner = useSettingsSessionOwner(token, undefined, standalone);
  return useSettingsLiveness(
    owner ? () => owner.token === token && owner.readCurrent() : standalone ? standaloneCurrent : unavailable,
  );
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
