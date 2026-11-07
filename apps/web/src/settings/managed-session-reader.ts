import type { AccountSessionSource } from './ports/accounts';
import { useAccounts } from './managed-account-capabilities';
import { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

/** Read-only custody of one original session observation, never a credential or an authority grant. */
export class ManagedSessionReader {
  private retired = false;
  private attached = false;
  private started = false;
  private release: (() => void) | undefined;
  private listeners = new Set<() => void>();
  constructor(
    private readonly source: AccountSessionSource | undefined,
    readonly subject: string | null | undefined,
    readonly target: string | null | undefined,
    readonly token?: string | null,
  ) {}
  matches() {
    const query = this.source?.snapshot();
    const data = query?.data;
    return (
      !!this.subject &&
      !!this.target &&
      query?.status === 'success' &&
      data?.state === 'signed-in' &&
      data.subject === this.subject &&
      (this.token === undefined || data.csrfToken === this.token)
    );
  }
  isCurrent = (): boolean => {
    if (!this.retired && !this.matches()) this.retire();
    return !this.retired && (!this.started || this.attached);
  };
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
    for (const listener of this.listeners) listener();
  };
  attach = () => {
    if (this.retired) return () => {};
    this.started = true;
    this.attached = true;
    this.release ??= this.source?.subscribe((removed) => {
      if (removed || !this.matches()) this.retire();
    });
    if (!this.matches()) this.retire();
    return () => {
      this.attached = false; // Refuse dispatch in the cleanup/replay gap, too.
      // StrictMode reconnects synchronously and shares the original bounded read.
      queueMicrotask(() => {
        if (!this.attached) this.retire();
      });
    };
  };
}

/** A recovered session mounts fresh custody; a token is supplied only for token-bound observations. */
export function useManagedSessionReader(
  subject: string | null | undefined,
  target: string | null | undefined,
  token?: string | null,
) {
  const { sessionSource: source } = useAccounts();
  const subscribe = useCallback((changed: () => void) => source?.subscribe(() => changed()) ?? (() => {}), [source]);
  const snapshot = useCallback(() => source?.snapshot(), [source]);
  // Keep observing recovery after an individual owner has permanently released its subscription.
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const ref = useRef<{ source: typeof source; owner: ManagedSessionReader } | null>(null);
  const previous = ref.current;
  // A retired owner is replaced only by a fresh observation that currently matches. Replacing it while the
  // session is unavailable would retire the replacement on attach and re-render forever.
  if (
    !previous ||
    previous.source !== source ||
    previous.owner.subject !== subject ||
    previous.owner.target !== target ||
    previous.owner.token !== token ||
    (previous.owner.snapshot() && new ManagedSessionReader(source, subject, target, token).matches())
  ) {
    previous?.owner.retire();
    ref.current = { source, owner: new ManagedSessionReader(source, subject, target, token) };
  }
  const owner = ref.current!.owner;
  useSyncExternalStore(owner.subscribe, owner.snapshot, owner.snapshot);
  useLayoutEffect(owner.attach, [owner]);
  return owner;
}

/** Fixture readers omit custody. Mounted production readers also refuse dispatch during effect detachment. */
export type ManagedReaderCurrent = () => boolean;

/** Delay terminal unmount disposal through synchronous effect replay, without restarting any IO. */
export function useManagedReaderLifetime(dispose: () => void, owner?: ManagedSessionReader) {
  const lease = useMemo(() => ({ attached: false }), [dispose, owner]);
  useLayoutEffect(() => {
    lease.attached = true;
    const unsubscribe = owner?.subscribe(() => {
      if (owner.snapshot()) dispose();
    });
    if (owner?.snapshot()) dispose();
    return () => {
      lease.attached = false;
      unsubscribe?.();
      queueMicrotask(() => {
        if (!lease.attached) dispose();
      });
    };
  }, [dispose, owner, lease]);
}

/** A retained native anchor cannot use an observation that retired before React commits its removal. */
export function managedNavigationGuard(current: ManagedReaderCurrent) {
  return (event: { target: EventTarget; preventDefault: () => void }) => {
    if (!current() && (event.target as Element).closest?.('a')) event.preventDefault();
  };
}
