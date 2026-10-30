import type { KernelClient } from '@rezics/client';

/** Consumer declaration only. The native queue producer owns selection and current admission. */
export type RealmClaimReviewPage = {
  claimRequests: {
    realmId: string;
    requestId: string;
    claimantAccountId: string;
    state: 'pending';
    orphanedAt: string;
    claimEligibleAt: string;
    requestedAt: string;
  }[];
  next: string | null;
};
export type RealmClaimReviewRequest = RealmClaimReviewPage['claimRequests'][number];
type ApprovalMethod = ReturnType<ReturnType<KernelClient['realms']>['claimRequests']>['$approve']['post'];
export type RealmClaimApprovalReceipt = NonNullable<Awaited<ReturnType<ApprovalMethod>>['data']>['claim'];
export type RealmClaimReviewRead =
  | { kind: 'ready'; page: RealmClaimReviewPage }
  | { kind: 'denied' | 'signed-out' | 'closed' | 'unavailable' };
export type RealmClaimApprovalInput = { realmId: string; requestId: string; idempotencyKey: string };
export type RealmClaimApprovalResult =
  | { kind: 'approved'; claim: RealmClaimApprovalReceipt }
  | { kind: 'conflict' | 'denied' | 'signed-out' | 'closed' | 'unavailable' };
export type RealmClaimReviewAdapter = {
  read: (input: { realmId: string; cursor?: string }) => Promise<RealmClaimReviewRead>;
  approve: (input: RealmClaimApprovalInput) => Promise<RealmClaimApprovalResult>;
};
export type RealmClaimReviewState = {
  read: RealmClaimReviewRead;
  cursor: string | undefined;
  intent: (RealmClaimApprovalInput & { source: RealmClaimReviewRequest }) | null;
  receipt: RealmClaimApprovalReceipt | null;
  outcome: 'idle' | 'confirming' | 'sending' | 'uncertain' | 'conflict' | 'refused' | 'approved';
  busy: boolean;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateRealmClaimReviewRead(input: { realmId: string; cursor?: string }) {
  if (
    typeof input?.realmId !== 'string' ||
    !uuid.test(input.realmId) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096))
  )
    throw new Error('Invalid Realm claim review read');
  return { realmId: input.realmId.toLowerCase(), ...(input.cursor ? { cursor: input.cursor } : {}) };
}
export function validateRealmClaimApproval(input: RealmClaimApprovalInput): RealmClaimApprovalInput {
  if (!uuid.test(input?.requestId) || !uuid.test(input?.idempotencyKey))
    throw new Error('Invalid Realm claim approval');
  return { ...validateRealmClaimReviewRead(input), requestId: input.requestId, idempotencyKey: input.idempotencyKey };
}

/** Reject undeclared disclosure and overfilled pages instead of forwarding or refilling them. */
export function realmClaimReviewPage(value: unknown, realmId: string): RealmClaimReviewPage | null {
  if (
    !record(value) ||
    !closed(value, ['claimRequests', 'next']) ||
    !Array.isArray(value.claimRequests) ||
    value.claimRequests.length > 20 ||
    !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 4096))
  )
    return null;
  const seen = new Set<string>();
  for (const row of value.claimRequests) {
    if (
      !record(row) ||
      !closed(row, [
        'realmId',
        'requestId',
        'claimantAccountId',
        'state',
        'orphanedAt',
        'claimEligibleAt',
        'requestedAt',
      ]) ||
      row.realmId !== realmId ||
      typeof row.requestId !== 'string' ||
      !uuid.test(row.requestId) ||
      typeof row.claimantAccountId !== 'string' ||
      !uuid.test(row.claimantAccountId) ||
      row.state !== 'pending' ||
      !date(row.orphanedAt) ||
      !date(row.claimEligibleAt) ||
      !date(row.requestedAt) ||
      seen.has(row.requestId)
    )
      return null;
    seen.add(row.requestId);
  }
  return value as RealmClaimReviewPage;
}

export function realmClaimApprovalReceipt(
  value: unknown,
  input: RealmClaimApprovalInput,
): RealmClaimApprovalReceipt | null {
  if (!record(value) || !closed(value, ['claim']) || !record(value.claim)) return null;
  const claim = value.claim;
  if (
    !closed(claim, ['realmId', 'requestId', 'claimantAccountId', 'state', 'orphanedAt', 'approvedAt']) ||
    claim.realmId !== input.realmId ||
    claim.requestId !== input.requestId ||
    typeof claim.claimantAccountId !== 'string' ||
    !uuid.test(claim.claimantAccountId) ||
    claim.state !== 'owned' ||
    !date(claim.orphanedAt) ||
    !date(claim.approvedAt)
  )
    return null;
  return claim as RealmClaimApprovalReceipt;
}

const sameSource = (a: RealmClaimReviewRequest, b: RealmClaimReviewRequest) =>
  (Object.keys(a) as (keyof RealmClaimReviewRequest)[]).every((key) => a[key] === b[key]);

/** A single visible native page and one deliberate intent. No role or clock supplies authority. */
export function createRealmClaimReview(
  realmId: string,
  initial: RealmClaimReviewRead,
  adapter: RealmClaimReviewAdapter,
  key: () => string = () => crypto.randomUUID(),
) {
  function safe(read: RealmClaimReviewRead): RealmClaimReviewRead {
    if (read.kind !== 'ready') return read;
    const page = realmClaimReviewPage(read.page, realmId);
    return page ? { kind: 'ready', page } : { kind: 'unavailable' };
  }
  let state: RealmClaimReviewState = {
    read: safe(initial),
    cursor: undefined,
    intent: null,
    receipt: null,
    outcome: 'idle',
    busy: false,
  };
  const listeners = new Set<() => void>();
  function update(change: Partial<RealmClaimReviewState>) {
    state = { ...state, ...change };
    listeners.forEach((listener) => listener());
  }
  async function load(cursor: string | undefined): Promise<RealmClaimReviewRead> {
    try {
      return safe(await adapter.read({ realmId, ...(cursor ? { cursor } : {}) }));
    } catch {
      return { kind: 'unavailable' };
    }
  }
  async function refresh(cursor = state.cursor) {
    if (state.busy) return;
    update({ busy: true, read: { kind: 'unavailable' } });
    const read = await load(cursor);
    update({
      read,
      cursor,
      busy: false,
      ...(state.outcome === 'confirming' ? { intent: null, outcome: 'idle' as const } : {}),
    });
  }
  async function send() {
    const intent = state.intent;
    if (!intent || state.busy || state.read.kind !== 'ready') return;
    update({ busy: true, outcome: 'sending', read: { kind: 'unavailable' } });
    let result: RealmClaimApprovalResult;
    try {
      result = await adapter.approve({ realmId, requestId: intent.requestId, idempotencyKey: intent.idempotencyKey });
    } catch {
      result = { kind: 'unavailable' };
    }
    const receipt = result.kind === 'approved' ? realmClaimApprovalReceipt({ claim: result.claim }, intent) : null;
    if (
      result.kind === 'approved' &&
      (!receipt ||
        receipt.claimantAccountId !== intent.source.claimantAccountId ||
        receipt.orphanedAt !== intent.source.orphanedAt)
    )
      result = { kind: 'unavailable' };
    if (result.kind === 'approved' && receipt) {
      // A receipt alone never enables another approval. Re-read the first native page first.
      const read = await load(undefined);
      update({ receipt, read, cursor: undefined, outcome: 'approved', busy: false });
    } else if (result.kind === 'unavailable') {
      update({ outcome: 'uncertain', busy: false });
    } else if (result.kind === 'conflict') {
      update({ outcome: 'conflict', busy: false });
    } else {
      update({
        read: { kind: result.kind === 'approved' ? 'unavailable' : result.kind },
        outcome: 'refused',
        busy: false,
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
    async next() {
      if (
        state.busy ||
        state.intent ||
        state.outcome !== 'idle' ||
        state.read.kind !== 'ready' ||
        !state.read.page.next
      )
        return;
      await refresh(state.read.page.next);
    },
    async prepare(requestId: string) {
      if (state.busy || state.intent || state.outcome !== 'idle' || state.read.kind !== 'ready') return;
      const source = state.read.page.claimRequests.find((row) => row.requestId === requestId);
      if (!source) return;
      update({ busy: true, read: { kind: 'unavailable' } });
      const read = await load(state.cursor);
      const current = read.kind === 'ready' ? read.page.claimRequests.find((row) => row.requestId === requestId) : null;
      if (current && sameSource(source, current)) {
        update({
          read,
          busy: false,
          outcome: 'confirming',
          intent: { realmId, requestId, idempotencyKey: key(), source: { ...current } },
        });
      } else update({ read, busy: false, outcome: read.kind === 'ready' ? 'conflict' : 'refused' });
    },
    cancel() {
      if (!state.busy && state.outcome === 'confirming') update({ intent: null, outcome: 'idle' });
    },
    async confirm() {
      if (state.outcome === 'confirming') await send();
    },
    async retry() {
      if (state.busy || state.outcome !== 'uncertain' || !state.intent) return;
      update({ busy: true, read: { kind: 'unavailable' } });
      const read = await load(state.cursor);
      update({ read, busy: false });
      // Replay may recover an applied result even if its request has left the pending queue.
      if (read.kind === 'ready') await send();
    },
    reviewCurrent() {
      if (!state.busy && state.read.kind === 'ready' && ['approved', 'conflict', 'refused'].includes(state.outcome))
        update({ intent: null, receipt: null, outcome: 'idle' });
    },
  };
}
