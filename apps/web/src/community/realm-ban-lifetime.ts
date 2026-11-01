import type { QueryClient } from '@tanstack/react-query';

type BanSession = { state: string; subject?: string | null; csrfToken?: string | null };

/** Observe every real cache transition, including an away/back pair batched by React. */
const sources = new WeakMap<QueryClient, ReturnType<typeof observeSession>>();
function observeSession(client: QueryClient) {
  const read = () => client.getQueryData<BanSession>(['session']);
  const key = () => {
    const value = read();
    return JSON.stringify([value?.state ?? 'unknown', value?.subject ?? null, value?.csrfToken ?? null]);
  };
  let previous = key();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 1 || query.queryKey[0] !== 'session') return;
    const next = key();
    if (previous === next) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    read,
    snapshot: () => revision,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export function realmBanSessionSource(client: QueryClient) {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

let sequence = 0;
/** Caller admission only. Native reads and commands still decide permission. */
export class RealmBanLifetime {
  readonly id = ++sequence;
  private retired = false;
  private connected = true;
  private serial = 0;
  private listeners = new Set<() => void>();
  constructor(
    private valid: () => boolean,
    private watch?: (listener: () => void) => () => void,
    private onDisconnect?: () => void,
  ) {}
  retire = () => {
    if (this.retired) return;
    this.retired = true;
    this.serial++;
    for (const listener of this.listeners) listener();
  };
  snapshot = () => {
    if (!this.retired && !this.valid()) this.retire();
    return this.retired;
  };
  current = () => this.connected && !this.snapshot();
  ticket = () => this.serial;
  owns = (ticket: number) => this.current() && this.serial === ticket;
  /** Layout ownership fences disconnection before passive effects or queued callbacks run. */
  connect = () => {
    this.connected = true;
    return () => {
      this.connected = false;
      this.serial++;
      this.onDisconnect?.();
      // Effect replay may reconnect this visit. Its disconnected work stays obsolete.
      queueMicrotask(() => {
        if (!this.connected) this.retire();
      });
    };
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const stop = this.watch?.(() => {
      this.snapshot();
    });
    this.snapshot();
    return () => {
      this.listeners.delete(listener);
      stop?.();
    };
  };
}
