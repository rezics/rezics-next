import type { Pool } from 'pg';
import { systemClock } from '../clock.ts';
import { installAccessClock } from './access-clock.ts';
import {
  ContinuationDeniedError,
  continuationEntryDigest,
  type ContinuationEntry,
  type ContinuationSnapshot,
} from './committed-continuations.ts';
import { createLifecycleInternals } from './lifecycle.ts';
import { createOperatorCommands, type OperatorResponsibility } from './operator.ts';
import { createAccess } from './permission.ts';

/** Steps this runner owns. Auth owns the others a deletion lists and runs them itself. */
const OWNED = new Set(['retire-operator', 'release-operator', 'redirect-deleted-handle']);
const AUTH_OWNED = new Set(['erase-auth-owner', 'revoke-auth-sessions']);
function allow(value: unknown): asserts value {
  if (!value) throw new ContinuationDeniedError();
}

/** Runs the kernel-owned steps of a committed deletion continuation in allowlist order.
 * Each step is recorded on the root through the expiry-checked authorization, then
 * rechecked live, before its native command runs under the step's committed key. The
 * commands are idempotent on that key, so Auth's own workflow and this runner can
 * both reach the same step without repeating its effect. */
export function createCommittedDeletionRunner(config: {
  pool: Pool;
  clock?: () => Date;
  root(reference: string): Promise<ContinuationSnapshot>;
  authorizeStep(reference: string, entry: ContinuationEntry): Promise<unknown>;
  /** Refuses unless the root's stored expiry is still in the future. */
  live(root: ContinuationSnapshot): Promise<void>;
}) {
  const clock = config.clock ?? systemClock;
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({ actions, accountEvidence: () => null });
  installAccessClock(access, clock);
  const operators = createOperatorCommands({
    pool: config.pool,
    actions,
    access,
    managementAction: 'account:manage',
  });
  const lifecycle = createLifecycleInternals({
    pool: config.pool,
    clock,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  function responsibility(root: ContinuationSnapshot, entry: ContinuationEntry): OperatorResponsibility {
    const operator = root.priorOperatorAccountId;
    const reservation = root.priorReservationId;
    allow(operator && reservation);
    const retiring = entry.step === 'retire-operator';
    allow(entry.target === `${retiring ? root.accountId : operator}:${reservation}`);
    return { operatorAccountId: operator, subjectAccountId: root.accountId, reservationId: reservation };
  }
  function effect(root: ContinuationSnapshot, entry: ContinuationEntry): () => Promise<unknown> {
    if (entry.step === 'retire-operator') {
      const held = responsibility(root, entry);
      return () => operators.retireResponsibility({ ...held, key: entry.key });
    }
    if (entry.step === 'release-operator') {
      const held = responsibility(root, entry);
      return () => operators.releaseResponsibility({ ...held, key: entry.key });
    }
    allow(root.priorHandle && entry.target === root.priorHandle);
    const handle = root.priorHandle;
    return () => lifecycle.redirectHandle({ accountId: root.accountId, handle, key: entry.key });
  }
  return {
    async continueCommitted(reference: string) {
      const root = await config.root(reference);
      for (const item of root.allowlist) {
        allow(OWNED.has(item.step) || AUTH_OWNED.has(item.step));
        if (!OWNED.has(item.step)) continue;
        allow(item.digest === continuationEntryDigest(item) && item.key === `${root.commandKeyPrefix}:${item.step}`);
        const run = effect(root, item);
        await config.authorizeStep(reference, item);
        // A completed step replays from its receipt, so expiry is checked again before any effect.
        await config.live(root);
        await run();
      }
    },
  };
}
