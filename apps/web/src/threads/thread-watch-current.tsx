import { threadPageOperation } from './thread-page-advice';
import type { ThreadPageObservation } from './thread-page';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { normalizeSessionObservation } from '../reader/lifetime/index';
import {
  threadWatchNative,
  type ThreadWatchCommand,
  type ThreadWatchNative,
  type ThreadWatchOwner,
  type ThreadWatchReadResult,
} from './thread-watch-native';

export type ThreadWatchProps = {
  threadId: string;
  session: string;
  sessionKnown: boolean;
  viewerId?: string | undefined;
  sessionStamp: string;
  admitted: boolean;
  canStart?: () => boolean;
  allowDiscard?: boolean;
  returnTo: string;
  /** A current native card can seed this visit without a per-thread status request. */
  initialWatching?: boolean;
  /** A current source may have no usable watch operation without having failed to load. */
  adviceState?: 'empty' | 'denied' | 'unavailable';
  /** Re-read the current Thread or Subject source. This never submits a watch command. */
  refreshAdvice?: () => Promise<void>;
  observation?: ThreadPageObservation;
  /** The admitted page/source identity, separate from a repeated thread ID. */
  readAuthority?: object;
  isCurrent?: () => boolean;
  /** Prepared views can supply an isolated native transport; the mounted entry uses the default. */
  native?: ThreadWatchNative;
};

export type ThreadWatchView = Readonly<{
  phase:
    | 'checking'
    | 'sending'
    | 'confirmed'
    | 'read-failed'
    | 'unknown'
    | 'refused'
    | 'access-lost'
    | 'unavailable'
    | 'advice-empty'
    | 'advice-denied'
    | 'advice-unavailable'
    | 'advice-refresh-failed'
    | 'retired';
  watching?: boolean;
  confirmation?: boolean;
  refreshingAdvice?: boolean;
  /** Only an unresolved write retains an exact requested state. A read is never its receipt. */
  command?: ThreadWatchCommand;
}>;

type Binding = {
  props: ThreadWatchProps;
  client: QueryClient | undefined;
  sessionData: unknown;
  sessionStatus: string | undefined;
  native: ThreadWatchNative;
};

function binding(props: ThreadWatchProps, client: QueryClient | undefined): Binding {
  const state = client?.getQueryState(['session']);
  return {
    props,
    client,
    sessionData: state?.data,
    sessionStatus: state?.status,
    native: props.native ?? threadWatchNative,
  };
}

function sameBinding(left: Binding, right: Binding, retainCommand = false): boolean {
  return (
    left.client === right.client &&
    left.sessionData === right.sessionData &&
    left.sessionStatus === right.sessionStatus &&
    left.native === right.native &&
    left.props.threadId === right.props.threadId &&
    left.props.viewerId === right.props.viewerId &&
    left.props.session === right.props.session &&
    left.props.sessionKnown === right.props.sessionKnown &&
    left.props.sessionStamp === right.props.sessionStamp &&
    left.props.admitted === right.props.admitted &&
    (retainCommand ||
      (left.props.initialWatching === right.props.initialWatching &&
        left.props.adviceState === right.props.adviceState)) &&
    left.props.observation === right.props.observation &&
    left.props.readAuthority === right.props.readAuthority
  );
}

/**
 * One admitted browser visit, with a native baseline or one private point read and at most one in-flight operation.
 * There is no global visit list, abort-controller collection, poller, or server receipt journal.
 * Retirement revokes local dispatch and result authority; it does not cancel a remote write.
 */
export class ThreadWatchVisit {
  private view: ThreadWatchView = Object.freeze({ phase: 'checking' });
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private connected = false;
  private dead = false;
  private replacement = false;
  private accessLost = false;
  private started = false;
  private active: object | undefined;
  private readonly owner: ThreadWatchOwner;
  readonly ready: boolean;

  constructor(
    readonly binding: Binding,
    private readonly latest: () => Binding,
  ) {
    const props = binding.props;
    const session = normalizeSessionObservation(binding.sessionData);
    const observedReady =
      !binding.client ||
      (binding.sessionStatus === 'success' &&
        session.state === 'signed-in' &&
        session.subject === props.viewerId &&
        !!session.csrfToken);
    this.ready = !!(
      props.sessionKnown &&
      props.session === 'signed-in' &&
      props.viewerId &&
      props.admitted &&
      observedReady
    );
    if (this.ready && typeof props.initialWatching === 'boolean') {
      this.started = true;
      this.view = Object.freeze({ phase: 'confirmed', watching: props.initialWatching });
    } else if (this.ready && props.adviceState) {
      this.started = true;
      this.view = Object.freeze({ phase: `advice-${props.adviceState}` as ThreadWatchView['phase'] });
    }
    this.owner = Object.freeze({
      threadId: props.threadId,
      viewerId: props.viewerId ?? '',
      sessionStamp: props.sessionStamp,
      ...(session.csrfToken ? { csrfToken: session.csrfToken } : {}),
      isCurrent: () => this.current(),
    });
    if (!props.admitted) this.view = Object.freeze({ phase: 'access-lost' });
  }

  get replaceable() {
    return this.replacement;
  }
  matches(value: Binding) {
    return sameBinding(this.binding, value, !!this.view.command);
  }
  snapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(view: ThreadWatchView) {
    this.view = Object.freeze(view);
    for (const listener of this.listeners) listener();
  }

  retire = (replace = false, notify = true) => {
    if (this.dead) return;
    this.dead = true;
    this.replacement = replace;
    this.connected = false;
    this.active = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    // Drop confirmation, requested state and command ownership immediately, before a replacement render.
    if (notify) this.publish({ phase: 'retired' });
    else this.view = Object.freeze({ phase: 'retired' });
  };

  current = (): boolean => {
    if (this.dead || this.accessLost || !this.connected || !this.ready) return false;
    const next = this.latest();
    const observed = binding(this.binding.props, this.binding.client);
    if (!this.matches(next) || !this.matches(observed) || !(this.binding.props.isCurrent?.() ?? true)) {
      this.retire();
      return false;
    }
    return true;
  };

  connect = () => {
    if (this.dead) return () => {};
    this.connected = true;
    const client = this.binding.client;
    this.unsubscribe = client?.getQueryCache().subscribe((event) => {
      if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
      const replacement =
        event.type === 'added' ||
        event.type === 'removed' ||
        (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'));
      if (!replacement) return;
      // Observe each transition synchronously. Away/back cannot restore an old visit even when React batches it.
      this.retire(true);
    });
    if (this.ready && !this.started && this.current()) {
      this.started = true;
      void this.read();
    }
    return () => this.retire(true);
  };

  private loseAccess() {
    this.accessLost = true;
    this.active = undefined;
    this.publish({ phase: 'access-lost' });
  }

  private acceptRead(result: ThreadWatchReadResult, unresolved: ThreadWatchCommand | undefined) {
    if (result.kind === 'access-lost') {
      this.loseAccess();
    } else if (unresolved) {
      // A private point read has no receipt. Keep the original command and never authorize its inverse.
      this.publish(
        result.kind === 'unavailable'
          ? { phase: 'unavailable', command: unresolved }
          : { phase: 'unknown', command: unresolved },
      );
    } else if (
      result.kind === 'confirmed' &&
      typeof result.state?.watching === 'boolean' &&
      Object.keys(result.state).length === 1
    ) {
      // Current status, independently observed. No claim about the earlier uncertain operation.
      this.publish({ phase: 'confirmed', watching: result.state.watching });
    } else {
      this.publish({
        phase: result.kind === 'unavailable' ? 'unavailable' : 'read-failed',
      });
    }
  }

  read = async () => {
    if (!this.current() || this.active) return;
    const ticket = {};
    const unresolved = this.view.command;
    this.active = ticket;
    this.publish({ phase: 'checking', ...(unresolved ? { command: unresolved } : {}) });
    try {
      // The slot is acquired synchronously, before invoking even a prepared async adapter.
      if (!this.current()) return;
      const result = await this.binding.native.read(
        Object.freeze({
          ...this.owner,
          fetch: Object.freeze({ cache: 'no-store' as const }),
        }),
      );
      if (this.current() && this.active === ticket) this.acceptRead(result, unresolved);
    } catch {
      if (this.current() && this.active === ticket)
        this.publish({
          phase: 'read-failed',
          ...(unresolved ? { command: unresolved } : {}),
        });
    } finally {
      if (this.active === ticket) this.active = undefined;
    }
  };

  canBegin = () => {
    const page = this.binding.props.observation;
    return (
      (this.latest().props.canStart?.() ?? true) &&
      (!page ||
        threadPageOperation(
          page,
          { kind: 'thread', id: this.owner.threadId },
          this.view.watching ? 'thread.unwatch' : 'thread.watch',
        ) === 'available')
    );
  };

  begin = () => {
    if (!this.current() || this.active || this.view.phase !== 'confirmed' || typeof this.view.watching !== 'boolean')
      return;
    if (
      typeof this.binding.props.initialWatching === 'boolean' &&
      this.view.watching !== this.binding.props.initialWatching
    )
      return;
    if (!this.canBegin()) return;
    const command = Object.freeze({ ...this.owner, watching: !this.view.watching });
    void this.send(command);
  };

  retry = () => {
    if (!this.current() || this.active || !this.view.command) return;
    void this.send(this.view.command);
  };

  discard = () => {
    if (!this.current() || this.active || !this.view.command) return;
    this.publish({ phase: 'read-failed' });
    void this.read();
  };

  refreshAdvice = async () => {
    const refresh = this.binding.props.refreshAdvice;
    if (!refresh || !this.current() || this.active) return;
    const previous = this.view;
    if (
      !(
        (previous.phase === 'confirmed' && typeof previous.confirmation === 'boolean') ||
        previous.phase === 'advice-empty' ||
        previous.phase === 'advice-denied' ||
        previous.phase === 'advice-unavailable' ||
        previous.phase === 'advice-refresh-failed'
      )
    )
      return;
    const ticket = {};
    this.active = ticket;
    this.publish({ ...previous, refreshingAdvice: true });
    const failed = (): ThreadWatchView => ({
      phase: 'advice-refresh-failed',
      ...(typeof previous.watching === 'boolean' ? { watching: previous.watching } : {}),
      ...(typeof previous.confirmation === 'boolean' ? { confirmation: previous.confirmation } : {}),
    });
    try {
      if (!this.current()) return;
      await refresh();
      // A source replacement retires this visit; unchanged advice is not proof of a fresh read.
      if (this.current() && this.active === ticket) this.publish(failed());
    } catch {
      if (this.current() && this.active === ticket) this.publish(failed());
    } finally {
      if (this.active === ticket) this.active = undefined;
    }
  };

  private async send(command: ThreadWatchCommand) {
    if (!this.current() || this.active) return;
    const ticket = {};
    this.active = ticket;
    this.publish({ phase: 'sending', command });
    try {
      if (!this.current()) return;
      const result = await this.binding.native.set(command);
      if (!this.current() || this.active !== ticket) return;
      if (result.kind === 'confirmed') {
        // 204 confirms this requested operation at its response, without a version lock or follow-up GET.
        this.publish({ phase: 'confirmed', watching: command.watching, confirmation: command.watching });
      } else if (result.kind === 'refused') {
        if (result.reason === 'access-lost') this.loseAccess();
        else this.publish({ phase: result.reason === 'unavailable' ? 'unavailable' : 'refused' });
      } else this.publish({ phase: 'unknown', command });
    } catch {
      if (this.current() && this.active === ticket) this.publish({ phase: 'unknown', command });
    } finally {
      if (this.active === ticket) this.active = undefined;
    }
  }
}

/** Existing query-cache observation only: this hook never asks for a session or access read. */
export function useThreadWatchCurrent(props: ThreadWatchProps) {
  const client = useContext(QueryClientContext);
  const next = binding(props, client);
  const latest = useRef(next);
  latest.current = next;
  const stored = useRef<ThreadWatchVisit | undefined>(undefined);
  if (!stored.current || stored.current.replaceable || !stored.current.matches(next)) {
    stored.current?.retire(false, false);
    stored.current = new ThreadWatchVisit(next, () => latest.current);
  }
  const visit = stored.current;
  const view = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  useLayoutEffect(visit.connect, [visit]);
  return { visit, view };
}
