import type { DiscoveryViewerFact, DiscoveryViewerQuestion } from './discovery';

/** These observations belong to the mounted Search host, never a URL or public cache key. */
export type DiscoveryPersonalScope = {
  viewer: string;
  credential: string;
  locale: string;
  page: string;
  request: string;
  registry: string;
  generation: string;
  admission: string;
};

export type DiscoveryPersonalTarget = {
  rowKey: string;
  originalSubjectId: string;
  subjectId: string;
  entry: DiscoveryViewerFact['entry'];
  vote: DiscoveryViewerFact['vote'];
  question: DiscoveryViewerQuestion | null;
};
export type DiscoveryPersonalObservation = {
  scope: DiscoveryPersonalScope;
  targets: readonly DiscoveryPersonalTarget[];
};
export type DiscoveryCommandFamily = 'entry' | 'vote';
export type DiscoveryCommandResult = 'successful' | 'rejected' | 'uncertain';
export type DiscoveryCommandState = 'idle' | 'pending' | DiscoveryCommandResult | 'retired';

/** Share across page incarnations. There is no queue and an uncertain command is never resent. */
export function createDiscoveryCommandRegistry() {
  const active = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return {
    isActive: (identity: string) => active.has(identity),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    acquire(identity: string): (() => void) | undefined {
      if (active.has(identity)) return;
      active.add(identity);
      changed();
      return () => {
        active.delete(identity);
        changed();
      };
    },
  };
}
export type DiscoveryCommandRegistry = ReturnType<typeof createDiscoveryCommandRegistry>;

// Compare explicitly ordered fields, independent of the caller's object property order.
function scopeKey(scope: DiscoveryPersonalScope): string {
  return JSON.stringify([
    scope.viewer,
    scope.credential,
    scope.locale,
    scope.page,
    scope.request,
    scope.registry,
    scope.generation,
    scope.admission,
  ]);
}

function targetKey(target: DiscoveryPersonalTarget): string {
  const question = target.question;
  const entry = target.entry;
  const vote = target.vote;
  return JSON.stringify([
    target.rowKey,
    target.originalSubjectId,
    target.subjectId,
    entry.state,
    entry.state === 'present' ? [entry.incarnationId, entry.entryState, entry.revision] : null,
    vote.state,
    vote.state !== 'unavailable' ? [vote.questionId, vote.questionRevision] : vote.reason,
    vote.state === 'present' ? [vote.units, vote.revision] : null,
    question
      ? [
          question.id,
          question.revision,
          question.grain,
          question.meaning,
          question.scale.min,
          question.scale.max,
          question.scale.displayStep,
        ]
      : null,
  ]);
}

/**
 * One controlled page lifetime. The host's observation must disappear as soon as session, exposure or admission
 * is no longer current. This is a stale-dispatch guard; native command ports still authorize each write.
 */
export function createDiscoveryPersonalPage(input: {
  observation: DiscoveryPersonalObservation;
  observe: () => DiscoveryPersonalObservation | undefined;
  registry: DiscoveryCommandRegistry;
  refresh: (signal: AbortSignal) => Promise<void>;
  retirePrivate: () => void;
  activate?: () => void;
}) {
  const captured = structuredClone(input.observation);
  const encoded = new TextEncoder();
  if (
    captured.targets.length > 100 ||
    encoded.encode(
      JSON.stringify(
        captured.targets.map((target) => ({ rowKey: target.rowKey, subjectId: target.originalSubjectId })),
      ),
    ).length > 16384 ||
    encoded.encode(JSON.stringify(captured.targets)).length > 65536
  )
    throw new RangeError('Discovery personal page exceeds its identity or byte bound');
  if (new Set(captured.targets.map((target) => target.rowKey)).size !== captured.targets.length)
    throw new TypeError('Discovery personal page repeats a row key');
  const scope = scopeKey(captured.scope);
  const targets = new Map(captured.targets.map((target) => [target.rowKey, target]));
  const signatures = new Map(captured.targets.map((target) => [target.rowKey, targetKey(target)]));
  const listeners = new Set<() => void>();
  const states = new Map<string, DiscoveryCommandState>();
  const controller = new AbortController();
  let disposed = false;
  let retired = false;
  let refreshNeeded = false;
  let refreshStarted = false;
  let pending = 0;
  let revision = 0;
  const stopRegistry = input.registry.subscribe(changed);

  function owns(): boolean {
    if (disposed) return false;
    const current = input.observe();
    const matches =
      !!current &&
      scopeKey(current.scope) === scope &&
      current.targets.length === targets.size &&
      new Set(current.targets.map((target) => target.rowKey)).size === targets.size &&
      current.targets.every((target) => signatures.get(target.rowKey) === targetKey(target));
    if (!matches) {
      // Once observed retired, an A → B → A transition cannot reopen an old form.
      disposed = true;
      stopRegistry();
      controller.abort();
    }
    return matches;
  }
  function changed() {
    revision++;
    for (const listener of listeners) listener();
  }
  function stateKey(rowKey: string, family: DiscoveryCommandFamily) {
    return JSON.stringify([rowKey, family]);
  }
  function identity(target: DiscoveryPersonalTarget, family: DiscoveryCommandFamily) {
    return JSON.stringify([
      captured.scope.viewer,
      target.subjectId,
      family,
      family === 'vote' ? target.question?.id : null,
    ]);
  }
  function mark(target: DiscoveryPersonalTarget, family: DiscoveryCommandFamily, state: DiscoveryCommandState) {
    // Different kinds/routes can be occurrences of the same native Subject.
    for (const other of targets.values())
      if (identity(other, family) === identity(target, family)) states.set(stateKey(other.rowKey, family), state);
    changed();
  }
  function retire() {
    if (retired || !owns()) return;
    retired = true;
    input.retirePrivate();
    changed();
  }
  async function refreshWhenSettled() {
    if (!refreshNeeded || pending !== 0 || refreshStarted || !owns()) return;
    refreshStarted = true;
    // The host owns complete read settlement, including failed reads and deliberate read retries.
    await input.refresh(controller.signal);
  }

  return {
    locale: captured.scope.locale,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => revision,
    current: () => !retired && owns(),
    accepts: (target: DiscoveryPersonalTarget) => signatures.get(target.rowKey) === targetKey(target),
    state(rowKey: string, family: DiscoveryCommandFamily): DiscoveryCommandState {
      if (!owns()) return 'retired';
      const target = targets.get(rowKey);
      if (target && input.registry.isActive(identity(target, family))) return 'pending';
      const state = states.get(stateKey(rowKey, family));
      return state ?? (retired ? 'retired' : 'idle');
    },
    /** No optimistic fact changes: a known rejection leaves the still-owned facts intact. */
    async execute(
      rowKey: string,
      family: DiscoveryCommandFamily,
      send: (target: DiscoveryPersonalTarget, idempotencyKey: string) => Promise<DiscoveryCommandResult>,
    ): Promise<DiscoveryCommandState> {
      if (retired || !owns()) return 'retired';
      const target = targets.get(rowKey);
      if (!target) return 'retired';
      const release = input.registry.acquire(identity(target, family));
      if (!release) return 'pending';
      pending++;
      mark(target, family, 'pending');
      let result: DiscoveryCommandResult;
      try {
        // A subscription can retire the host synchronously when pending is published.
        if (retired || !owns()) return 'retired';
        input.activate?.();
        result = await send(structuredClone(target), crypto.randomUUID());
      } catch {
        result = 'uncertain';
      } finally {
        release();
        pending--;
      }
      if (!owns()) return 'retired';
      mark(target, family, result);
      if (!owns()) return 'retired';
      if (result !== 'rejected') {
        refreshNeeded = true;
        retire();
      }
      // Concurrent entry and vote writes are independent; a single refresh waits for both to settle.
      await refreshWhenSettled();
      return owns() ? result : 'retired';
    },
    dispose() {
      stopRegistry();
      disposed = true;
      controller.abort();
      changed();
      listeners.clear();
    },
  };
}

export type DiscoveryPersonalPage = ReturnType<typeof createDiscoveryPersonalPage>;
