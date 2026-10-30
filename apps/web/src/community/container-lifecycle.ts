/** Presentation boundary only. The native lifecycle client has not landed in this checkout.
 * An integration adapter must map its actual closed reads, command results and current admission;
 * these types declare no HTTP routes, role policy, authority tokens or native DTOs.
 */
export type ContainerTarget = Readonly<{ kind: 'space' | 'realm'; id: string }>;
export type LifecycleAction = 'remove' | 'restore';
export type LifecycleSnapshot = Readonly<{
  target: ContainerTarget;
  head: string;
  state: 'active' | 'removed' | 'orphaned';
  contextId: string | null;
  /** Only commands admitted by the current native read; never inferred from roles or provenance. */
  actions: readonly LifecycleAction[];
}>;
export type LifecycleProblem = Readonly<{
  kind: 'refused';
  status: number;
  code: string;
  detail?: string;
}>;
export type LifecycleRead = { kind: 'ready'; snapshot: LifecycleSnapshot } | LifecycleProblem | { kind: 'unavailable' };
export type LifecycleIntent = Readonly<{
  target: ContainerTarget;
  action: LifecycleAction;
  expectedHead: string;
  idempotencyKey: string;
  reason: string;
  /** The pointer observed with this intent, retained for response and destination validation. */
  contextId: string | null;
}>;
export type LifecycleResult =
  | { kind: 'confirmed'; target: ContainerTarget; action: LifecycleAction; head: string; contextId: string | null }
  | LifecycleProblem
  | { kind: 'unavailable' };
export type LifecycleDestination =
  | { kind: 'available'; target: ContainerTarget; contextId: string | null; href: string }
  | { kind: 'unavailable' };
export type ContainerLifecycleAdapter = Readonly<{
  read: (target: ContainerTarget) => Promise<LifecycleRead>;
  change: (intent: LifecycleIntent) => Promise<LifecycleResult>;
  /** Independently rechecks current container read and live Context read, including publication where needed. */
  destination: (target: ContainerTarget, contextId: string | null) => Promise<LifecycleDestination>;
}>;

/** Fail closed until the producer's actual client and authority mapping are integrated. No demo runtime. */
export const unavailableLifecycleAdapter: ContainerLifecycleAdapter = {
  read: async () => ({ kind: 'unavailable' }),
  change: async () => ({ kind: 'unavailable' }),
  destination: async () => ({ kind: 'unavailable' }),
};

export type LifecycleState = Readonly<{
  read: LifecycleRead | { kind: 'loading' };
  reason: string;
  intent: LifecycleIntent | null;
  outcome: 'none' | 'sending' | 'uncertain' | 'refused' | 'conflict' | 'confirmed';
  problem: LifecycleProblem | null;
  destination: string | null;
  busy: boolean;
  /** A fresh read is required before reviewing a refused intent as a new command. */
  reviewed: boolean;
}>;

function sameTarget(a: ContainerTarget, b: ContainerTarget) {
  return a.id === b.id && a.kind === b.kind;
}

export function offeredActions(state: LifecycleState): readonly LifecycleAction[] {
  if (state.busy || state.read.kind !== 'ready' || !['none', 'confirmed'].includes(state.outcome)) return [];
  const snapshot = state.read.snapshot;
  if (snapshot.state === 'orphaned') return [];
  return snapshot.actions.filter((action) =>
    action === 'remove' ? snapshot.state === 'active' : snapshot.state === 'removed',
  );
}

export function mayRetryLifecycle(state: LifecycleState) {
  return (
    !state.busy &&
    state.outcome === 'uncertain' &&
    state.intent !== null &&
    state.read.kind === 'ready' &&
    state.read.snapshot.state !== 'orphaned'
  );
}

/** One target and one immutable request per intent. Refresh never rebases a request or claims its effect. */
export function createContainerLifecycle(
  target: ContainerTarget,
  adapter: ContainerLifecycleAdapter,
  key: () => string = () => crypto.randomUUID(),
) {
  const anchor = Object.freeze({ ...target });
  let state: LifecycleState = {
    read: { kind: 'loading' },
    reason: '',
    intent: null,
    outcome: 'none',
    problem: null,
    destination: null,
    busy: false,
    reviewed: false,
  };
  const listeners = new Set<() => void>();
  function update(change: Partial<LifecycleState>) {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  async function read(): Promise<LifecycleRead> {
    try {
      const result = await adapter.read(anchor);
      if (result.kind === 'ready' && (!sameTarget(anchor, result.snapshot.target) || !result.snapshot.head))
        return { kind: 'unavailable' };
      return result;
    } catch {
      return { kind: 'unavailable' };
    }
  }
  async function refresh() {
    if (state.busy) return;
    update({ busy: true, destination: null });
    const result = await read();
    const destination =
      state.outcome === 'confirmed' && state.intent ? await destinationFor(state.intent, result) : null;
    update({ read: result, destination, busy: false, reviewed: result.kind === 'ready' });
  }
  async function destinationFor(intent: LifecycleIntent, current: LifecycleRead): Promise<string | null> {
    if (
      intent.action !== 'restore' ||
      current.kind !== 'ready' ||
      current.snapshot.state !== 'active' ||
      current.snapshot.contextId !== intent.contextId
    )
      return null;
    try {
      const link = await adapter.destination(anchor, intent.contextId);
      if (
        link.kind === 'available' &&
        sameTarget(anchor, link.target) &&
        link.contextId === intent.contextId &&
        link.href.startsWith('/') &&
        !link.href.startsWith('//') &&
        !/[\\\u0000-\u001f]/u.test(link.href)
      )
        return link.href;
    } catch {
      // An independently unavailable Context never substitutes Global or an old link.
    }
    return null;
  }
  async function send(intent: LifecycleIntent) {
    update({ busy: true, outcome: 'sending', problem: null, destination: null, reviewed: false });
    let result: LifecycleResult;
    try {
      result = await adapter.change(intent);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (
      result.kind === 'confirmed' &&
      (!sameTarget(anchor, result.target) ||
        result.action !== intent.action ||
        result.contextId !== intent.contextId ||
        !result.head)
    )
      result = { kind: 'unavailable' };
    if (result.kind === 'unavailable') {
      update({ busy: false, outcome: 'uncertain' });
      return;
    }
    if (result.kind === 'refused') {
      update({
        busy: false,
        outcome: result.status === 409 || result.status === 412 ? 'conflict' : 'refused',
        problem: result,
        read: result,
      });
      return;
    }
    // A command acknowledgement confirms its effect, but does not authorize a restored link or another command.
    update({ outcome: 'confirmed' });
    const current = await read();
    const destination = await destinationFor(intent, current);
    update({ read: current, busy: false, destination, reviewed: current.kind === 'ready' });
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setReason(reason: string) {
      if (!state.busy && !state.intent) update({ reason });
    },
    async submit(action: LifecycleAction) {
      if (!offeredActions(state).includes(action) || state.read.kind !== 'ready') return;
      if (action === 'remove' && !state.reason.trim()) return;
      const snapshot = state.read.snapshot;
      const intent: LifecycleIntent = Object.freeze({
        target: anchor,
        action,
        expectedHead: snapshot.head,
        idempotencyKey: key(),
        reason: state.reason,
        contextId: snapshot.contextId,
      });
      update({ intent });
      await send(intent);
    },
    async retry() {
      if (mayRetryLifecycle(state) && state.intent) await send(state.intent);
    },
    review() {
      if (
        state.busy ||
        !state.reviewed ||
        state.read.kind !== 'ready' ||
        !['conflict', 'refused', 'confirmed'].includes(state.outcome)
      )
        return;
      update({ intent: null, outcome: 'none', problem: null, destination: null });
    },
  };
}
