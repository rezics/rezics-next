/** Presentation boundary. Native admission and lifecycle policy belong to the kernel. */
export type ContainerTarget = Readonly<{ kind: 'space' | 'realm'; id: string }>;
export type LifecycleAction = 'remove' | 'restore';
export type LifecycleSnapshot = Readonly<{
  target: ContainerTarget;
  head: string;
  /** Native CAS, independent of the editorial head. Older presentation fixtures may omit it. */
  version?: string;
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
  expectedVersion?: string;
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
  read: (target: ContainerTarget, observedContextId?: string | null) => Promise<LifecycleRead>;
  change: (intent: LifecycleIntent) => Promise<LifecycleResult>;
  /** Independently rechecks current container read and live Context read, including publication where needed. */
  destination: (target: ContainerTarget, contextId: string | null) => Promise<LifecycleDestination>;
}>;

/** Optional mounted-caller authority supplied by the browser composition. */
export type LifecycleCallerOwnership = Readonly<{
  current: () => boolean;
  ticket: () => number;
  owns: (ticket: number) => boolean;
}>;

const unboundOwnership: LifecycleCallerOwnership = {
  current: () => true,
  ticket: () => 0,
  owns: (ticket) => ticket === 0,
};

/** Explicit unavailable fixture; production controls compose the native adapter. */
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

/** Keep an unresolved operation recoverable even when a fresh read offers no new action. */
export function lifecycleControlsPresentation(state: LifecycleState) {
  const snapshot = state.read.kind === 'ready' ? state.read.snapshot : null;
  const canRetry = mayRetryLifecycle(state);
  const visible = snapshot !== null && snapshot.state !== 'orphaned' && (snapshot.actions.length > 0 || canRetry);
  return {
    visible,
    readOnly: visible && snapshot !== null && snapshot.actions.length === 0 && !canRetry,
    canRetry,
  };
}

/** One target and one immutable request per intent. Refresh never rebases a request or claims its effect. */
export function createContainerLifecycle(
  target: ContainerTarget,
  adapter: ContainerLifecycleAdapter,
  key: () => string = () => crypto.randomUUID(),
  ownership: LifecycleCallerOwnership = unboundOwnership,
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
  let operationTicket: number | null = null;

  function normalizeStaleBusy() {
    if (state.busy && operationTicket !== null && ownership.current() && !ownership.owns(operationTicket)) {
      state = { ...state, busy: false };
      operationTicket = null;
    }
  }

  function update(change: Partial<LifecycleState>, ticket?: number) {
    if (!ownership.current() || (ticket !== undefined && !ownership.owns(ticket))) return false;
    state = { ...state, ...change };
    for (const listener of listeners) {
      if (!ownership.current() || (ticket !== undefined && !ownership.owns(ticket))) break;
      listener();
    }
    return true;
  }
  async function read(ticket: number): Promise<LifecycleRead> {
    // Adapters may be reached through queued transports; retirement wins before the request starts.
    await Promise.resolve();
    if (!ownership.owns(ticket)) return { kind: 'unavailable' };
    try {
      const observedContextId =
        state.intent?.contextId ?? (state.read.kind === 'ready' ? state.read.snapshot.contextId : null);
      const result = await adapter.read(anchor, observedContextId);
      if (!ownership.owns(ticket)) return { kind: 'unavailable' };
      if (result.kind === 'ready' && (!sameTarget(anchor, result.snapshot.target) || !result.snapshot.head))
        return { kind: 'unavailable' };
      return result;
    } catch {
      if (!ownership.owns(ticket)) return { kind: 'unavailable' };
      return { kind: 'unavailable' };
    }
  }
  async function refresh() {
    normalizeStaleBusy();
    if (!ownership.current() || state.busy) return;
    const ticket = ownership.ticket();
    operationTicket = ticket;
    if (!update({ busy: true, destination: null }, ticket)) return;
    const result = await read(ticket);
    if (!ownership.owns(ticket)) return;
    const destination =
      state.outcome === 'confirmed' && state.intent ? await destinationFor(state.intent, result, ticket) : null;
    if (!ownership.owns(ticket)) return;
    operationTicket = null;
    update({ read: result, destination, busy: false, reviewed: result.kind === 'ready' }, ticket);
  }
  async function destinationFor(
    intent: LifecycleIntent,
    current: LifecycleRead,
    ticket: number,
  ): Promise<string | null> {
    if (
      !ownership.owns(ticket) ||
      intent.action !== 'restore' ||
      current.kind !== 'ready' ||
      current.snapshot.state !== 'active' ||
      current.snapshot.contextId !== intent.contextId
    )
      return null;
    await Promise.resolve();
    if (!ownership.owns(ticket)) return null;
    try {
      const link = await adapter.destination(anchor, intent.contextId);
      if (!ownership.owns(ticket)) return null;
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
      if (!ownership.owns(ticket)) return null;
      // An independently unavailable Context never substitutes Global or an old link.
    }
    return null;
  }
  async function send(intent: LifecycleIntent, isNewIntent = false) {
    normalizeStaleBusy();
    if (!ownership.current() || state.busy) return;
    const ticket = ownership.ticket();
    operationTicket = ticket;
    if (
      !update(
        {
          ...(isNewIntent ? { intent } : {}),
          busy: true,
          outcome: 'sending',
          problem: null,
          destination: null,
          reviewed: false,
        },
        ticket,
      )
    )
      return;
    // Confirm ownership again at the transport boundary after synchronous listeners have run.
    await Promise.resolve();
    if (!ownership.owns(ticket)) return;
    let result: LifecycleResult;
    try {
      result = await adapter.change(intent);
    } catch {
      result = { kind: 'unavailable' };
    }
    if (!ownership.owns(ticket)) return;
    if (
      result.kind === 'confirmed' &&
      (!sameTarget(anchor, result.target) ||
        result.action !== intent.action ||
        result.contextId !== intent.contextId ||
        !result.head)
    )
      result = { kind: 'unavailable' };
    if (result.kind === 'unavailable') {
      operationTicket = null;
      update({ busy: false, outcome: 'uncertain' }, ticket);
      return;
    }
    if (result.kind === 'refused') {
      operationTicket = null;
      update(
        {
          busy: false,
          outcome: result.status === 409 || result.status === 412 ? 'conflict' : 'refused',
          problem: result,
          read: result,
        },
        ticket,
      );
      return;
    }
    // A command acknowledgement confirms its effect, but does not authorize a restored link or another command.
    update({ outcome: 'confirmed' }, ticket);
    if (!ownership.owns(ticket)) return;
    const current = await read(ticket);
    if (!ownership.owns(ticket)) return;
    const destination = await destinationFor(intent, current, ticket);
    if (!ownership.owns(ticket)) return;
    operationTicket = null;
    update({ read: current, busy: false, destination, reviewed: current.kind === 'ready' }, ticket);
  }
  return {
    getSnapshot: () => {
      normalizeStaleBusy();
      return state;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    setReason(reason: string) {
      normalizeStaleBusy();
      if (ownership.current() && !state.busy && !state.intent) update({ reason });
    },
    async submit(action: LifecycleAction) {
      normalizeStaleBusy();
      if (!ownership.current() || !offeredActions(state).includes(action) || state.read.kind !== 'ready') return;
      if (action === 'remove' && !state.reason.trim()) return;
      const snapshot = state.read.snapshot;
      const intent: LifecycleIntent = Object.freeze({
        target: anchor,
        action,
        expectedHead: snapshot.head,
        ...(snapshot.version === undefined ? {} : { expectedVersion: snapshot.version }),
        idempotencyKey: key(),
        reason: state.reason,
        contextId: snapshot.contextId,
      });
      await send(intent, true);
    },
    async retry() {
      normalizeStaleBusy();
      if (ownership.current() && mayRetryLifecycle(state) && state.intent) await send(state.intent);
    },
    review() {
      normalizeStaleBusy();
      if (
        !ownership.current() ||
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
