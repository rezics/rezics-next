import type { KernelClient } from '@rezics/client';
import { realmClaimStatusResponse, type RealmClaimStatus, type RealmClaimStatusRead } from './realm-claim-status';

type NativeRealm = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['realms']>['get']>>['data']>['realm'];
export type RealmClaimSnapshot = Pick<
  NativeRealm,
  | 'realmId'
  | 'spaceId'
  | 'contextId'
  | 'headRevisionId'
  | 'ownershipState'
  | 'orphanedAt'
  | 'claimEligibleAt'
  | 'governanceReadOnly'
>;
export type RealmClaimReceipt = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['realms']>['claimRequests']['post']>>['data']
>;
export type RealmClaimRead =
  | {
      kind: 'ready';
      snapshot: RealmClaimSnapshot;
      admission: 'allowed' | 'denied' | 'signed-out' | 'unavailable';
    }
  | { kind: 'denied' | 'closed' | 'unavailable' };
export type RealmClaimInput = { realmId: string; idempotencyKey: string };
export type RealmClaimResult =
  | { kind: 'pending'; request: RealmClaimReceipt }
  | { kind: 'signed-out' | 'denied' | 'closed' | 'conflict' | 'unavailable' };
export type RealmClaimAdapter = {
  read: (realmId: string) => Promise<RealmClaimRead>;
  request: (input: RealmClaimInput) => Promise<RealmClaimResult>;
  mine?: (realmId: string) => Promise<RealmClaimStatusRead>;
};
export type RealmClaimIntent = Readonly<RealmClaimInput & { source: RealmClaimSnapshot }>;
export type RealmClaimState = {
  read: RealmClaimRead;
  intent: RealmClaimIntent | null;
  request: RealmClaimReceipt | null;
  outcome: 'idle' | 'sending' | 'uncertain' | 'conflict' | 'refused' | 'pending';
  busy: boolean;
  reviewed: boolean;
  recovered: RealmClaimStatus | null;
  recovery: 'unchecked' | 'none' | 'found' | 'unavailable' | 'unused';
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateRealmClaimRead(input: { realmId: string }) {
  if (typeof input?.realmId !== 'string' || !uuid.test(input.realmId)) throw new Error('Invalid Realm claim read');
  return { realmId: input.realmId.toLowerCase() };
}
export function validateRealmClaimInput(input: RealmClaimInput): RealmClaimInput {
  if (typeof input?.idempotencyKey !== 'string' || !uuid.test(input.idempotencyKey))
    throw new Error('Invalid Realm claim request');
  return { ...validateRealmClaimRead(input), idempotencyKey: input.idempotencyKey };
}

/** No role, membership, timer or creator identity supplies this decision. */
export function realmClaimSnapshot(realm: NativeRealm): RealmClaimSnapshot | null {
  if (
    realm.state !== 'active' ||
    !realm.realmId ||
    !realm.spaceId ||
    !realm.contextId ||
    !realm.headRevisionId ||
    (realm.ownershipState !== 'owned' && realm.ownershipState !== 'orphaned') ||
    realm.governanceReadOnly !== (realm.ownershipState === 'orphaned') ||
    (realm.ownershipState === 'orphaned'
      ? !Number.isFinite(Date.parse(realm.orphanedAt ?? '')) ||
        !Number.isFinite(Date.parse(realm.claimEligibleAt ?? ''))
      : realm.orphanedAt !== null || realm.claimEligibleAt !== null)
  )
    return null;
  const {
    realmId,
    spaceId,
    contextId,
    headRevisionId,
    ownershipState,
    orphanedAt,
    claimEligibleAt,
    governanceReadOnly,
  } = realm;
  return {
    realmId,
    spaceId,
    contextId,
    headRevisionId,
    ownershipState,
    orphanedAt,
    claimEligibleAt,
    governanceReadOnly,
  };
}

export function sameRealmClaimSource(a: RealmClaimSnapshot, b: RealmClaimSnapshot) {
  return (Object.keys(a) as (keyof RealmClaimSnapshot)[]).every((key) => a[key] === b[key]);
}
export function mayRequestRealmClaim(state: RealmClaimState) {
  return (
    !state.busy &&
    !state.intent &&
    (state.recovery === 'none' || state.recovery === 'unused') &&
    state.outcome === 'idle' &&
    state.read.kind === 'ready' &&
    state.read.admission === 'allowed' &&
    state.read.snapshot.ownershipState === 'orphaned'
  );
}
export function mayRetryRealmClaim(state: RealmClaimState) {
  return (
    !state.busy &&
    state.outcome === 'uncertain' &&
    !!state.intent &&
    state.read.kind === 'ready' &&
    state.read.admission === 'allowed' &&
    sameRealmClaimSource(state.intent.source, state.read.snapshot)
  );
}

/** Local intent and receipt presentation only; ownership always comes from a fresh native read. */
export function createRealmClaim(
  realmId: string,
  initial: RealmClaimRead,
  adapter: RealmClaimAdapter,
  key: () => string = () => crypto.randomUUID(),
) {
  let state: RealmClaimState = {
    read: initial,
    intent: null,
    request: null,
    outcome: 'idle',
    busy: false,
    reviewed: false,
    recovered: null,
    recovery: adapter.mine ? 'unchecked' : 'unused',
  };
  let generation = 0;
  const listeners = new Set<() => void>();
  function update(change: Partial<RealmClaimState>) {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  async function refresh() {
    if (state.busy) return;
    const version = ++generation;
    update({ busy: true });
    let read: RealmClaimRead;
    try {
      read = await adapter.read(realmId);
    } catch {
      read = { kind: 'unavailable' };
    }
    if (version !== generation) return;
    if (read.kind === 'ready' && read.snapshot.realmId !== realmId) read = { kind: 'unavailable' };
    let recovered: RealmClaimStatus | null = null;
    let recovery: RealmClaimState['recovery'] = adapter.mine ? 'unchecked' : 'unused';
    if (
      adapter.mine &&
      read.kind === 'ready' &&
      read.admission === 'allowed' &&
      read.snapshot.ownershipState === 'orphaned'
    ) {
      let mine: RealmClaimStatusRead;
      try {
        mine = await adapter.mine(realmId);
      } catch {
        mine = { kind: 'unavailable' };
      }
      if (version !== generation) return;
      recovery = 'unavailable';
      if (mine.kind === 'ready' && sameRealmClaimSource(mine.source, read.snapshot)) {
        const receipt = realmClaimStatusResponse({ claimRequest: mine.claimRequest }, { realmId });
        if (receipt === null) recovery = 'none';
        else if (receipt && receipt.orphanedAt === read.snapshot.orphanedAt) {
          recovered = receipt;
          recovery = 'found';
        }
      } else if (mine.kind === 'denied' || mine.kind === 'closed') read = { kind: mine.kind };
      else if (mine.kind === 'signed-out') read = { ...read, admission: 'signed-out' };
      else if (mine.kind === 'ready') read = { kind: 'unavailable' };
    }
    update({ read, recovered, recovery, busy: false, reviewed: read.kind === 'ready' });
  }
  async function send(intent: RealmClaimIntent) {
    const version = ++generation;
    update({ busy: true, outcome: 'sending', reviewed: false });
    let result: RealmClaimResult;
    try {
      result = await adapter.request({ realmId: intent.realmId, idempotencyKey: intent.idempotencyKey });
    } catch {
      result = { kind: 'unavailable' };
    }
    if (
      result.kind === 'pending' &&
      (result.request.realmId !== realmId ||
        !uuid.test(result.request.requestId) ||
        result.request.state !== 'pending' ||
        result.request.orphanedAt !== intent.source.orphanedAt ||
        result.request.claimEligibleAt !== intent.source.claimEligibleAt ||
        !Number.isFinite(Date.parse(result.request.requestedAt)))
    )
      result = { kind: 'unavailable' };
    if (result.kind === 'pending') {
      update({ request: result.request, outcome: 'pending', busy: false });
    } else if (result.kind === 'unavailable') {
      update({ outcome: 'uncertain', busy: false });
    } else {
      update({
        outcome: result.kind === 'conflict' ? 'conflict' : 'refused',
        busy: false,
        read:
          version !== generation
            ? state.read
            : result.kind === 'conflict'
              ? { kind: 'unavailable' }
              : result.kind === 'signed-out'
                ? { kind: 'ready', snapshot: intent.source, admission: 'signed-out' }
                : { kind: result.kind },
      });
    }
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
    observePage(snapshot: RealmClaimSnapshot) {
      if (
        snapshot.realmId !== realmId ||
        (state.read.kind === 'ready' && sameRealmClaimSource(state.read.snapshot, snapshot))
      )
        return;
      // A new page payload updates the native source but supplies no personal admission or replacement intent.
      generation++;
      update({
        read: { kind: 'ready', snapshot, admission: 'unavailable' },
        reviewed: false,
        busy: false,
        recovered: null,
        recovery: adapter.mine ? 'unchecked' : 'unused',
      });
    },
    observeUnavailable(read: Exclude<RealmClaimRead, { kind: 'ready' }>) {
      generation++;
      update({ read, reviewed: false, busy: false, recovered: null, recovery: adapter.mine ? 'unchecked' : 'unused' });
    },
    async submit() {
      if (!mayRequestRealmClaim(state) || state.read.kind !== 'ready') return;
      const intent = Object.freeze({
        realmId,
        idempotencyKey: key(),
        source: Object.freeze({ ...state.read.snapshot }),
      });
      update({ intent });
      await send(intent);
    },
    async retry() {
      if (mayRetryRealmClaim(state) && state.intent) await send(state.intent);
    },
    review() {
      if (
        state.busy ||
        !state.reviewed ||
        state.read.kind !== 'ready' ||
        !['conflict', 'refused'].includes(state.outcome)
      )
        return;
      update({ intent: null, outcome: 'idle', reviewed: false });
    },
  };
}
