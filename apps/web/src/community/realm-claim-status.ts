import { validateRealmClaimRead, type RealmClaimSnapshot } from './realm-claim';
import type { RealmClaimCallerLifetime } from './realm-claim-caller-lifetime';

/** Declared requester DTO; the original native reader owns identity and episode decisions. */
export type RealmClaimStatus = Readonly<{
  realmId: string;
  requestId: string;
  state: 'pending' | 'approved';
  orphanedAt: string;
  requestedAt: string;
  approvedAt: string | null;
  currentEpisode: boolean;
}>;
export type RealmClaimStatusInput = { realmId: string; requestId?: string };
export type RealmClaimStatusRead =
  | { kind: 'ready'; claimRequest: RealmClaimStatus | null; source: RealmClaimSnapshot }
  | { kind: 'signed-out' | 'denied' | 'closed' | 'unavailable' };
export type RealmClaimStatusAdapter = { read: (input: RealmClaimStatusInput) => Promise<RealmClaimStatusRead> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRealmClaimStatusRead(input: RealmClaimStatusInput): RealmClaimStatusInput {
  const { realmId } = validateRealmClaimRead(input);
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !uuid.test(input.requestId)))
    throw new Error('Invalid Realm claim request reference');
  return { realmId, ...(input.requestId !== undefined ? { requestId: input.requestId.toLowerCase() } : {}) };
}

export function realmClaimStatusResponse(value: unknown, input: RealmClaimStatusInput) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('claimRequest' in value))
    return undefined;
  const row = value.claimRequest;
  if (row === null) return input.requestId === undefined ? null : undefined;
  if (!row || typeof row !== 'object') return undefined;
  const fields = ['realmId', 'requestId', 'state', 'orphanedAt', 'requestedAt', 'approvedAt', 'currentEpisode'];
  if (Object.keys(row).length !== fields.length || Object.keys(row).some((key) => !fields.includes(key)))
    return undefined;
  const fact = row as Record<string, unknown>;
  const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
  if (
    fact.realmId !== input.realmId ||
    typeof fact.requestId !== 'string' ||
    !uuid.test(fact.requestId) ||
    (input.requestId !== undefined && fact.requestId !== input.requestId) ||
    (fact.state !== 'pending' && fact.state !== 'approved') ||
    !date(fact.orphanedAt) ||
    !date(fact.requestedAt) ||
    (fact.state === 'pending' ? fact.approvedAt !== null : !date(fact.approvedAt)) ||
    typeof fact.currentEpisode !== 'boolean' ||
    (input.requestId === undefined && !fact.currentEpisode)
  )
    return undefined;
  return row as RealmClaimStatus;
}

/** One foreground point read per mount/check. No timers, polling, commands or receipt-based grants. */
export function createRealmClaimStatus(
  input: RealmClaimStatusInput,
  initial: RealmClaimStatusRead,
  adapter: RealmClaimStatusAdapter,
  lifetime?: RealmClaimCallerLifetime,
) {
  function current(read: RealmClaimStatusRead): RealmClaimStatusRead {
    if (
      read.kind === 'ready' &&
      (read.source.realmId !== input.realmId ||
        realmClaimStatusResponse({ claimRequest: read.claimRequest }, input) === undefined)
    )
      return { kind: 'unavailable' };
    return read;
  }
  const initialRead = current(initial);
  let state = { read: initialRead, busy: false };
  let generation = 0;
  let disconnected = false;
  const listeners = new Set<() => void>();
  const hiddenState = { read: { kind: 'unavailable' as const }, busy: false };
  function update(read: RealmClaimStatusRead, busy = false) {
    state = { read: current(read), busy };
    for (const listener of listeners) listener();
  }
  function callerCurrent() {
    return !disconnected && (!lifetime || lifetime.current());
  }
  return {
    getSnapshot: () => (callerCurrent() ? state : hiddenState),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observe(read: RealmClaimStatusRead) {
      if (!callerCurrent()) return;
      generation++;
      update(read);
    },
    async refresh() {
      if (state.busy || !callerCurrent()) return;
      const version = ++generation;
      const callerTicket = lifetime?.ticket() ?? 0;
      const owns = () => !disconnected && generation === version && (!lifetime || lifetime.owns(callerTicket));
      // Never leave an old positive receipt visible while current disclosure is being checked.
      update({ kind: 'unavailable' }, true);
      let read: RealmClaimStatusRead;
      try {
        if (!owns()) return;
        read = await adapter.read(input);
      } catch {
        read = { kind: 'unavailable' };
      }
      if (!owns()) return;
      update(read);
    },
    disconnect() {
      disconnected = true;
      generation++;
      if (!lifetime) state = { read: initialRead, busy: false };
      for (const listener of listeners) listener();
    },
    reconnect() {
      disconnected = false;
    },
  };
}
