import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { currentCommand, IdempotencyConflictError, runCommand } from '../../src/command/command.ts';
import {
  runPublisherActivation,
  resolvePublisherActivation,
  cleanupPublisherResults,
  PublisherOutcomeUncertainError,
  publisherCommandWork,
  PUBLISHER_COMMAND_COST,
} from '../../src/command/publisher-coordination.ts';
import { preparePublisherActivationResult } from '../../src/command/publisher-activation-result.ts';
import { catalogueMechanicalSelection } from '../../src/semantic/definition-catalogue-mechanical.ts';
import type { CatalogueMechanicalInput } from '../../src/semantic/definition-catalogue-types.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { observeSql } from '../content/support/sql-observer.ts';

let db: GrowthDatabase;
const bodyWork = {
  candidateKeys: 0,
  nativeRows: 1,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 1,
  witnessKeys: 0,
  statements: 1,
  bytes: 256,
};
type Input = Extract<CatalogueMechanicalInput, { phase: 'activation-step' }>;
const input = (): Input => ({
  format: 'catalogue-mechanical-input/1',
  phase: 'activation-step',
  root: `sha256:${'a'.repeat(64)}`,
  episode: randomUUID(),
  activationId: randomUUID(),
  position: '0',
  deadline: Date.now() + 180000,
});
const result = (selected: Input) => ({
  phase: 'activation-step' as const,
  progress: { activationId: selected.activationId, state: 'closing' as const, pending: true },
});
const deadline = () => Date.now() + 10000;
beforeAll(async () => {
  db = await openGrowthDatabase();
  await db.admin.query(
    'CREATE TABLE public.publisher_effect(id uuid PRIMARY KEY, effects integer NOT NULL, transaction_id uuid NOT NULL)',
  );
});
afterAll(async () => {
  await db?.close();
});
async function effect(tx: Parameters<Parameters<typeof runPublisherActivation>[2]>[0], selected: Input) {
  await tx.query(
    `INSERT INTO public.publisher_effect VALUES($1,1,$2)
    ON CONFLICT(id) DO UPDATE SET effects=publisher_effect.effects+1`,
    [selected.activationId, currentCommand(tx).transactionId],
  );
  return result(selected);
}
const apply = (selected: Input, pool = db.pool) =>
  runPublisherActivation(pool, { input: selected, bodyWork }, (tx) => effect(tx, selected));
async function count(selected: Input) {
  return (
    (await db.admin.query('SELECT effects FROM public.publisher_effect WHERE id=$1', [selected.activationId])).rows[0]
      ?.effects ?? 0
  );
}
async function envelope() {
  return (
    await db.admin.query(`SELECT position::text,
    (SELECT count(*)::int FROM core.outbox WHERE partition_no=0) AS events,
    (SELECT count(*)::int FROM core.receipt WHERE partition_no=0) AS receipts,
    (SELECT count(*)::int FROM editorial.write_basis WHERE partition_no=0) AS basis
    FROM core.partition WHERE partition_no=0`)
  ).rows[0]!;
}

test('one eventless native coordination effect and canonical result commit; restart replays and changed input refuses', async () => {
  const selected = input();
  const before = await envelope();
  const first = await apply(selected);
  const after = await envelope();
  expect(first.replayed).toBe(false);
  expect(after).toEqual({ ...before, position: (BigInt(before.position) + 1n).toString() });
  const restarted = createPool(db.url);
  try {
    expect(await apply({ ...selected }, restarted)).toEqual({ ...first, replayed: true });
    expect(await resolvePublisherActivation(restarted, selected, deadline())).toEqual({
      status: 'committed',
      outcome: { ...first, replayed: true },
    });
    await expect(apply({ ...selected, episode: randomUUID() }, restarted)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(
      await resolvePublisherActivation(restarted, { ...selected, deadline: selected.deadline + 1 }, deadline()),
    ).toEqual({ status: 'conflicting' });
    expect(await count(selected)).toBe(1);
    const saved = (
      await db.admin.query(
        'SELECT result_bytes,result_digest,transaction_id FROM core.publisher_operation WHERE original_key=$1',
        [catalogueMechanicalSelection(selected).originalKey],
      )
    ).rows[0]!;
    expect(saved.result_bytes).toEqual(preparePublisherActivationResult(selected, result(selected)).bytes);
    expect(saved.transaction_id).toBe(first.transactionId);
  } finally {
    await restarted.end();
  }
});

test('lost COMMIT response resolves from the database on a new connection without repeating effects', async () => {
  const selected = input();
  const observer = observeSql(db.pool);
  observer.armFault({
    match: { statement: 'COMMIT' },
    boundary: 'after',
    error: new Error('lost publisher COMMIT response'),
  });
  try {
    await expect(apply(selected)).rejects.toThrow('lost publisher COMMIT response');
  } finally {
    await observer.close();
  }
  const restarted = createPool(db.url);
  try {
    const resolved = await resolvePublisherActivation(restarted, selected, deadline());
    expect(resolved.status).toBe('committed');
    const replay = await apply(selected, restarted);
    expect(replay.replayed).toBe(true);
    if (resolved.status === 'committed') expect(replay).toEqual(resolved.outcome);
    expect(await count(selected)).toBe(1);
  } finally {
    await restarted.end();
  }
});

test('a precommit locator and canonical caller buffer cannot prove completion; rollback removes both association and effect', async () => {
  const selected = input();
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempt = runPublisherActivation(db.pool, { input: selected, bodyWork }, async (tx) => {
    await effect(tx, selected);
    expect(currentCommand(tx).transactionId).toHaveLength(36);
    expect(preparePublisherActivationResult(selected, result(selected)).bytes.length).toBeGreaterThan(0);
    entered();
    await held;
    throw new Error('rollback publisher');
  });
  const failed = expect(attempt).rejects.toThrow('rollback publisher');
  await waiting;
  const restarted = createPool(db.url);
  try {
    expect(await resolvePublisherActivation(restarted, selected, deadline())).toEqual({ status: 'uncertain' });
  } finally {
    release();
    await failed;
    await restarted.end();
  }
  expect(await count(selected)).toBe(0);
  expect(await resolvePublisherActivation(db.pool, selected, deadline())).toEqual({ status: 'uncertain' });
  await apply(selected);
  expect(await count(selected)).toBe(1);
});

test('finite body work refuses excess statements atomically; ordinary empty events still refuse', async () => {
  const selected = input();
  await expect(
    runPublisherActivation(db.pool, { input: selected, bodyWork }, async (tx) => {
      await effect(tx, selected);
      return effect(tx, selected);
    }),
  ).rejects.toThrow('exceeds declared finite command work');
  expect(await count(selected)).toBe(0);
  expect(await resolvePublisherActivation(db.pool, selected, deadline())).toEqual({ status: 'uncertain' });
  expect(() => publisherCommandWork({ ...bodyWork, statements: Infinity })).toThrow();
  expect(publisherCommandWork(bodyWork).statements).toBe(13);
  expect(PUBLISHER_COMMAND_COST.association.bytes).toBeGreaterThan(131072);
  await expect(runCommand(db.pool, { partition: 0 }, async () => ({ value: null, events: [] }))).rejects.toThrow(
    'must emit at least one event',
  );
});

test('indexed result minimization preserves a conflict binding and uncertainty without permitting a second effect', async () => {
  const selected = input();
  await apply(selected);
  await db.admin.query(
    "UPDATE core.publisher_operation SET retain_until=now()-interval '1 day' WHERE original_key=$1",
    [catalogueMechanicalSelection(selected).originalKey],
  );
  expect(await cleanupPublisherResults(db.pool, deadline(), 1)).toBe(1);
  expect(await resolvePublisherActivation(db.pool, selected, deadline())).toEqual({ status: 'uncertain' });
  await expect(apply(selected)).rejects.toBeInstanceOf(PublisherOutcomeUncertainError);
  await expect(apply({ ...selected, episode: randomUUID() })).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await count(selected)).toBe(1);
});
