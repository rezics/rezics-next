import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { temporaryDirectory } from './test-support.ts';
import {
  beginPromotionGroupWindow,
  beginPromotionParentWindow,
  finishPromotionGroupWindow,
  finishPromotionParentWindow,
  linkPromotionParentWindow,
  markPromotionGroupPhase,
  PROMOTION_LAUNCH_SOURCE_UNAVAILABLE,
  PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE,
  readPromotionGroupWindows,
  readPromotionParentWindows,
  recordPromotionCustodyUnavailable,
  recoverIncompletePromotionWindows,
  type PromotionGroupWindow,
} from './promotion-observation.ts';

function group(db: ReturnType<typeof openDb>, input: { parentWindowId?: string; at: string; promotionId?: string }) {
  return beginPromotionGroupWindow(db, {
    ...(input.parentWindowId === undefined ? {} : { parentWindowId: input.parentWindowId }),
    promotionId: input.promotionId ?? 'promotion-a',
    group: 'head',
    commit: 'a'.repeat(40),
    commands: [['env', 'GATE_REMOTE_SLOTS=3', 'bun', 'scripts/gate.ts']],
    at: input.at,
  });
}

test('logical promotion windows persist distinct phases and leave unsupported physical evidence unknown', () => {
  const temporary = temporaryDirectory();
  const path = join(temporary.path, 'promotion.sqlite');
  let db = openDb(path);
  try {
    const parent = beginPromotionParentWindow(db, null, '2026-10-30T00:00:00.000Z');
    expect(readPromotionParentWindows(db).find((row) => row.id === parent)?.promotionId).toBeNull();
    const id = group(db, { parentWindowId: parent, at: '2026-10-30T00:00:01.000Z' });
    linkPromotionParentWindow(db, parent, 'promotion-a');
    expect(readPromotionParentWindows(db).find((row) => row.id === parent)?.promotionId).toBe('promotion-a');

    // Logical admission and phase timestamps are independently recorded. They make no physical-host claim.
    const phaseTimes = [
      ['wait-ended', '2026-10-30T00:00:02.000Z'],
      ['admitted', '2026-10-30T00:00:03.000Z'],
      ['preparation-started', '2026-10-30T00:00:04.000Z'],
      ['preparation-ended', '2026-10-30T00:00:05.000Z'],
      ['execution-started', '2026-10-30T00:00:06.000Z'],
      ['execution-ended', '2026-10-30T00:00:07.000Z'],
    ] as const;
    for (const [phase, at] of phaseTimes) markPromotionGroupPhase(db, id, phase, at);
    finishPromotionGroupWindow(db, id, 'failed', false, '2026-10-30T00:00:08.000Z');
    finishPromotionParentWindow(db, parent, 'returned', '2026-10-30T00:00:09.000Z');

    const row = readPromotionGroupWindows(db).find((window) => window.id === id)!;
    expect(row).toMatchObject({
      parentWindowId: parent,
      promotionId: 'promotion-a',
      attempt: 1,
      waitStartedAt: '2026-10-30T00:00:01.000Z',
      waitEndedAt: '2026-10-30T00:00:02.000Z',
      admittedAt: '2026-10-30T00:00:03.000Z',
      preparationStartedAt: '2026-10-30T00:00:04.000Z',
      preparationEndedAt: '2026-10-30T00:00:05.000Z',
      executionStartedAt: '2026-10-30T00:00:06.000Z',
      executionEndedAt: '2026-10-30T00:00:07.000Z',
      terminalAt: '2026-10-30T00:00:08.000Z',
      outcome: 'failed',
      timedOut: false,
      physicalStatus: 'unavailable',
      physicalReason: PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE,
      sourceStatus: 'unavailable',
      sourceReason: PROMOTION_LAUNCH_SOURCE_UNAVAILABLE,
      launchSourceRevision: null,
      launchRemoteCheckSha256: null,
      integratedProducerRevision: null,
      integratedProducerSha256: null,
      clientCohort: null,
      physicalHost: null,
      physicalRunId: null,
      physicalGeneration: null,
      physicalIncarnation: null,
      physicalCgroup: null,
      sampleStartedAt: null,
      sampleEndedAt: null,
      resourceSampleCount: null,
      cpuPeakCores: null,
      cpuIntervalMs: null,
      cpuCoverageMs: null,
      memoryPeakBytes: null,
      memoryPeakScope: null,
    });
    expect(readPromotionParentWindows(db).find((window) => window.id === parent)).toMatchObject({
      promotionId: 'promotion-a',
      terminalAt: '2026-10-30T00:00:09.000Z',
      outcome: 'returned',
    });

    db.close();
    db = openDb(path);
    expect(readPromotionGroupWindows(db)).toHaveLength(1);
    expect(readPromotionGroupWindows(db)[0]).toMatchObject({ id, outcome: 'failed', physicalStatus: 'unavailable' });
  } finally {
    db.close();
    temporary.close();
  }
});

test('restarts preserve append-only group identity, failures, and unknown intervals; command metadata is bounded', () => {
  const temporary = temporaryDirectory();
  const path = join(temporary.path, 'promotion.sqlite');
  let db = openDb(path);
  try {
    const firstParent = beginPromotionParentWindow(db, 'promotion-a', '2026-10-30T01:00:00.000Z');
    const secondParent = beginPromotionParentWindow(db, 'promotion-b', '2026-10-30T01:00:00.000Z');
    const first = group(db, {
      parentWindowId: firstParent,
      at: '2026-10-30T01:00:01.000Z',
      promotionId: 'promotion-a',
    });
    finishPromotionGroupWindow(db, first, 'failed', false, '2026-10-30T01:00:10.000Z');
    const interrupted = group(db, {
      parentWindowId: secondParent,
      at: '2026-10-30T01:00:01.000Z',
      promotionId: 'promotion-b',
    });
    // Concurrent promotion identities retain independent windows instead of overwriting singleton recovery state.
    expect(first).not.toBe(interrupted);
    expect(
      readPromotionGroupWindows(db)
        .map((row) => row.promotionId)
        .sort(),
    ).toEqual(['promotion-a', 'promotion-b']);
    recoverIncompletePromotionWindows(db, '2026-10-30T01:02:00.000Z');

    db.close();
    db = openDb(path);
    const rows = readPromotionGroupWindows(db);
    expect(rows.find((row) => row.id === first)).toMatchObject({ outcome: 'failed', timedOut: false });
    expect(rows.find((row) => row.id === interrupted)).toMatchObject({
      outcome: 'interrupted',
      terminalAt: '2026-10-30T01:02:00.000Z',
      physicalStatus: 'unavailable',
      sourceStatus: 'unavailable',
      launchSourceRevision: null,
      launchRemoteCheckSha256: null,
      integratedProducerRevision: null,
      integratedProducerSha256: null,
      clientCohort: null,
      physicalHost: null,
      physicalRunId: null,
      physicalGeneration: null,
      physicalIncarnation: null,
      physicalCgroup: null,
      sampleStartedAt: null,
      sampleEndedAt: null,
      resourceSampleCount: null,
      cpuPeakCores: null,
      memoryPeakBytes: null,
    });
    expect(readPromotionParentWindows(db).map((row) => row.outcome)).toEqual(['interrupted', 'interrupted']);

    const afterRestartParent = beginPromotionParentWindow(db, 'promotion-a', '2026-10-30T01:03:00.000Z');
    const afterRestart = beginPromotionGroupWindow(db, {
      parentWindowId: afterRestartParent,
      promotionId: 'promotion-a',
      group: 'head',
      commit: 'b'.repeat(40),
      commands: [['x'.repeat(40_000)]],
      at: '2026-10-30T01:03:01.000Z',
    });
    const final = readPromotionGroupWindows(db).find((row) => row.id === afterRestart)!;
    expect(final.attempt).toBe(2);
    expect(final.id).not.toBe(first);
    expect(final.id).not.toBe(interrupted);
    expect(final.commands).toMatchObject({ omitted: true });
    expect((final.commands as { omitted: true; bytes: number }).bytes).toBeGreaterThan(32 * 1024);
    expect(final.physicalStatus).toBe('unavailable');
    expect(final.resourceSampleCount).toBeNull();
  } finally {
    db.close();
    temporary.close();
  }
});

test('without a public physical custody seam, nested markers and caller timeouts leave physical fields unknown', () => {
  const producer = readFileSync(join(import.meta.dir, '../../../scripts/remote-check.ts'), 'utf8');
  const observer = readFileSync(join(import.meta.dir, './promotion-observation.ts'), 'utf8');

  expect(producer).toContain('export function readHosts');
  expect(producer).toContain('export async function remoteCheck');
  expect(producer).not.toMatch(
    /export\s+(?:type|interface|function|const)\s+.*(?:Custody|Incarnation|CgroupDescriptor)/i,
  );
  expect(observer).toContain(PROMOTION_PHYSICAL_CUSTODY_UNAVAILABLE);
  expect(observer).not.toContain('exitCode');

  const temporary = temporaryDirectory();
  const db = openDb(join(temporary.path, 'promotion.sqlite'));
  try {
    const id = group(db, { at: '2026-10-30T02:00:00.000Z' });
    const nestedFixtureMarker =
      'nested output: physical-custody {"host":"c","run":"wrong-run","generation":"stale","cgroup":"/fixture","memoryPeakBytes":14936453120}';
    recordPromotionCustodyUnavailable(db, id, `caller exit 124; ${nestedFixtureMarker}`);
    // A caller-owned timeout/exit status and a nested marker cannot become physical evidence.
    finishPromotionGroupWindow(db, id, 'failed', true, '2026-10-30T02:00:01.000Z');
    const row = readPromotionGroupWindows(db)[0] as PromotionGroupWindow;
    expect(row).toMatchObject({
      outcome: 'failed',
      timedOut: true,
      physicalStatus: 'unavailable',
      sourceStatus: 'unavailable',
      sourceReason: PROMOTION_LAUNCH_SOURCE_UNAVAILABLE,
      launchSourceRevision: null,
      launchRemoteCheckSha256: null,
      integratedProducerRevision: null,
      integratedProducerSha256: null,
      clientCohort: null,
      physicalHost: null,
      physicalRunId: null,
      physicalGeneration: null,
      physicalIncarnation: null,
      physicalCgroup: null,
      sampleStartedAt: null,
      sampleEndedAt: null,
      resourceSampleCount: null,
      cpuPeakCores: null,
      cpuIntervalMs: null,
      cpuCoverageMs: null,
      memoryPeakBytes: null,
      memoryPeakScope: null,
    });
  } finally {
    db.close();
    temporary.close();
  }
});
