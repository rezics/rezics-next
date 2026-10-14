import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ErasureUnavailable } from '../../../services/main/src/modules/erasure/journal.ts';
import { verifyErasure } from '../../../services/main/src/modules/erasure/reconcile.ts';

/** Query-boundary fixture: the real journal reader and owner probes consume these
 * rows. It models the interruption between the owner tombstone and completion. */
function fixture() {
  const erasureId = randomUUID(),
    revisionId = randomUUID(),
    epoch = '7';
  const target = {
    ordinal: 1,
    owner: 'content',
    target_kind: 'content_revision',
    target_ref: revisionId,
    completion_state: 'pending',
    completion_reason_code: null as string | null,
    completion_evidence_ref: null as string | null,
    completed_at: null as Date | null,
  };
  let availability = 'erased',
    tombstoneEpoch = epoch,
    commentSource = false,
    evidenceSource = false;
  let inventory = true;
  let reconciliation: Record<string, unknown> | undefined;
  let verified = false,
    probes = 0;
  const dispositions: string[] = [];
  const relay = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM relay.owner_reconciliation WHERE operation_id')) {
        return { rows: reconciliation ? [reconciliation] : [] };
      }
      if (sql.includes('FROM relay.erasure WHERE id'))
        return {
          rows: [
            {
              id: erasureId,
              erasure_epoch: epoch,
              operation_id: randomUUID(),
              request_digest: 'a'.repeat(64),
              kind: 'revision',
              authority: 'access_admission',
              principal_id: randomUUID(),
              admission_id: randomUUID(),
              authority_epoch: '1',
              stage: verified ? 'verified' : 'inventory_complete',
              suppression_status: 'suppressed',
              destruction_status: 'retained',
              blocked_reason: null,
              requested_at: new Date(),
              suppressed_at: new Date(),
              verified_at: verified ? new Date() : null,
            },
          ],
        };
      if (sql.includes('FROM relay.erasure_target')) return { rows: [{ ...target }] };
      if (sql.includes('FROM relay.erasure_disposition'))
        return {
          rows: inventory
            ? [
                {
                  label: 'content:live',
                  owner: 'content',
                  store: 'postgresql',
                  custody: 'live',
                  suppression: 'suppressed',
                  destruction: 'retained',
                  retained_until: null,
                  reason: 'retained row versions',
                  evidence_digest: null,
                },
              ]
            : [],
        };
      if (sql.startsWith('INSERT INTO relay.owner_reconciliation (')) {
        reconciliation = {
          id: values[0],
          state: values[9],
          hold_reason: values[10],
          erasure_epoch: epoch,
          coverage_generation: null,
        };
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO relay.owner_reconciliation_item')) {
        dispositions.push(...(values[5] as string[]));
        return { rows: [] };
      }
      if (sql.includes('FROM relay.owner_reconciliation_item'))
        return {
          rows: [...new Set(dispositions)].map((disposition) => ({
            disposition,
            count: String(dispositions.filter((value) => value === disposition).length),
          })),
        };
      if (sql.startsWith('UPDATE relay.erasure SET stage')) {
        verified = true;
        return { rows: [] };
      }
      throw new Error(`Unexpected verifier Relay query: ${sql}`);
    },
  } as unknown as PoolClient;
  const content = {
    query: async (sql: string) => {
      if (sql.includes('SELECT wanted.id::text AS id, r.availability')) {
        probes++;
        return {
          rows: [
            {
              id: revisionId,
              availability,
              erasure_id: availability === 'erased' ? erasureId : null,
              erasure_epoch: availability === 'erased' ? tombstoneEpoch : null,
              payload_absent: !commentSource && !evidenceSource,
            },
          ],
        };
      }
      if (sql.includes('FROM content.comment')) {
        return { rows: commentSource ? [{ revision_id: revisionId }] : [] };
      }
      if (sql.includes('verification.open_evidence_source_revisions')) {
        return { rows: evidenceSource ? [{ revision_id: revisionId }] : [] };
      }
      throw new Error(`Unexpected verifier Content query: ${sql}`);
    },
  } as unknown as Pool;
  return {
    target,
    setAvailability: (value: string) => {
      availability = value;
    },
    setEpoch: (value: string) => {
      tombstoneEpoch = value;
    },
    setCommentSource: () => {
      commentSource = true;
    },
    setEvidenceSource: () => {
      evidenceSource = true;
    },
    omitInventory: () => {
      inventory = false;
    },
    complete: () => {
      target.completion_state = 'completed';
      target.completion_evidence_ref = 'b'.repeat(64);
      target.completed_at = new Date();
    },
    verify: () =>
      verifyErasure(relay as unknown as Pool, { content }, erasureId, randomUUID(), relay),
    get recorded() {
      return reconciliation !== undefined;
    },
    get verified() {
      return verified;
    },
    get probes() {
      return probes;
    },
  };
}

test('pending target rejects for erased and present revisions; durable completion plus fresh absence verifies', async () => {
  const f = fixture();
  await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
  expect(f.recorded).toBe(false);
  f.setAvailability('available');
  await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
  expect(f.recorded).toBe(false);
  expect(f.verified).toBe(false);
  f.complete();
  f.setAvailability('erased');
  expect((await f.verify()).state).toBe('reconciled');
  expect(f.probes).toBe(1);
  expect(f.verified).toBe(true);
});

test('durable target completion still requires a fresh owner absence probe', async () => {
  const f = fixture();
  f.complete();
  f.setAvailability('available');
  await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
  expect(f.probes).toBe(1);
  expect(f.recorded).toBe(false);
  expect(f.verified).toBe(false);
});

test('completed erased targets retain held reconciliation for an unrelated inventory gap', async () => {
  const f = fixture();
  f.complete();
  f.omitInventory();
  const result = await f.verify();
  expect(result.state).toBe('held');
  expect(result.counts).toEqual({ erased: 1, gap: 1 });
  expect(f.probes).toBe(1);
  expect(f.verified).toBe(false);
});

for (const fault of ['wrong epoch', 'open comment source', 'open evidence source']) {
  test(`completed erased target rejects with ${fault}`, async () => {
    const f = fixture();
    f.complete();
    if (fault === 'wrong epoch') f.setEpoch('6');
    else if (fault === 'open comment source') f.setCommentSource();
    else f.setEvidenceSource();
    await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
    expect(f.probes).toBe(1);
    expect(f.recorded).toBe(false);
    expect(f.verified).toBe(false);
  });
}

for (const state of ['failed', 'legacy']) {
  test(`${state} target rejects despite an erased revision`, async () => {
    const f = fixture();
    f.target.completion_state = state;
    await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
    expect(f.recorded).toBe(false);
  });
}

for (const fault of ['missing evidence', 'missing completion timestamp']) {
  test(`a completed target with ${fault} rejects`, async () => {
    const f = fixture();
    f.complete();
    if (fault === 'missing evidence') f.target.completion_evidence_ref = null;
    else f.target.completed_at = null;
    await expect(f.verify()).rejects.toBeInstanceOf(ErasureUnavailable);
    expect(f.recorded).toBe(false);
  });
}
