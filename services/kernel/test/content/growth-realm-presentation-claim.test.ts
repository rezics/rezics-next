import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkGrowth, seed, type GrowthReport } from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  emptyRealmPresentation,
  growthRealmPresentationClaimFixture,
  type GrowthRealm,
  type RealmPresentationAsset,
  type RealmPresentationInput,
} from './support/growth-realm-presentation-claim-fixture.ts';

const scales: [number, number, number] = [256, 1024, 4096];
const bounds = { statements: 'constant', rows: 'constant', blocks: 'logarithmic' } as const;
setDefaultTimeout(600_000);

let fixture: Awaited<ReturnType<typeof growthRealmPresentationClaimFixture>>;
beforeAll(async () => {
  fixture = await growthRealmPresentationClaimFixture();
}, 240_000);
afterAll(async () => fixture?.close());

type MeasuredCommand = Readonly<{
  realmId: string;
  expectedHead: string;
  key: string;
  revisionId: string;
  presentation: RealmPresentationInput;
}>;

function presentationFor(changes: 0 | 1 | 2, icon: RealmPresentationAsset | null, banner: RealmPresentationAsset | null) {
  return {
    avatarMediaId: changes >= 1 ? icon!.id : null,
    bannerMediaId: changes >= 2 ? banner!.id : null,
    rules: null,
  } as const;
}

function claimUpdateCount(sample: GrowthReport['samples'][number]): number {
  return sample.statementRepetitions
    .flat()
    .filter(({ statement }) => /\bUPDATE\s+content\.media\b/i.test(statement))
    .reduce((count, statement) => count + statement.count, 0);
}

function recordGrowth(report: GrowthReport) {
  process.stderr.write(
    `GROWTH_REVIEW ${JSON.stringify({
      check: report.name,
      bounds: report.bounds,
      samples: report.samples.map(({ scale, cost, statementRepetitions }) => ({
        scale,
        statements: cost.statements,
        rows: cost.rows,
        buffers: cost.blocks,
        sharedHit: cost.sharedHit,
        sharedRead: cost.sharedRead,
        runner: {
          statements: cost.backgroundStatements ?? 0,
          rows: cost.backgroundRows ?? 0,
          buffers: cost.backgroundBlocks ?? 0,
        },
        claimUpdates: statementRepetitions
          .flat()
          .filter(({ statement }) => /\bUPDATE\s+content\.media\b/i.test(statement))
          .reduce((count, statement) => count + statement.count, 0),
      })),
    })}\n`,
  );
}

async function assertSuccessfulBinding(command: MeasuredCommand) {
  const binding = await fixture.commandBinding(command.realmId, command.key, command.revisionId);
  expect(binding).toMatchObject({
    principal_kind: 'account',
    principal_id: fixture.actor.accountId,
    command_kind: 'community.realm.update',
    idempotency_key: command.key,
    client_id: fixture.actor.clientId,
    requested_by: fixture.actor.requestedBy,
    revision_id: command.revisionId,
    predecessor: command.expectedHead,
    author: fixture.actor.accountId,
    avatar_media_id: command.presentation.avatarMediaId,
    banner_media_id: command.presentation.bannerMediaId,
  });
}

function expectPhysicalSample(report: GrowthReport) {
  expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
  expect(report.bounds).toEqual(bounds);
  for (const sample of report.samples) {
    expect(sample.repetitions).toHaveLength(1);
    expect(sample.statementRepetitions).toHaveLength(1);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
  }
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  recordGrowth(report);
}

async function commandSeries(
  changes: 0 | 1 | 2,
  target: GrowthRealm,
  icon: RealmPresentationAsset | null,
  banner: RealmPresentationAsset | null,
  warmup: GrowthRealm,
  warmupIcon: RealmPresentationAsset | null,
  warmupBanner: RealmPresentationAsset | null,
): Promise<{ report: GrowthReport; commands: MeasuredCommand[]; selection: RealmPresentationInput }> {
  const selection = presentationFor(changes, icon, banner);
  const warmupSelection = presentationFor(changes, warmupIcon, warmupBanner);
  const name = `realm-presentation-unrelated-${changes}-${randomUUID()}`;
  const population = await fixture.unrelatedPopulation(name, target.realmId);
  const commands: MeasuredCommand[] = [];
  let prepared: { expectedHead: string; key: string } | undefined;
  const report = await checkGrowth(fixture.base.db, {
    name: `Realm presentation claim ${changes} changed slots against unrelated Realm/media population`,
    rule: 'series',
    scales,
    bounds,
    repetitions: 1,
    async grow(database, scale, previous) {
      if (previous > 0 && changes > 0) {
        const current = await fixture.read(target.realmId);
        if (current.presentation.avatarMediaId !== null || current.presentation.bannerMediaId !== null) {
          const cleared = await fixture.patch(
            target.realmId,
            current.headRevisionId,
            emptyRealmPresentation,
            `growth-clear-${changes}-${scale}-${randomUUID()}`,
          );
          expect(cleared.response.status).toBe(200);
          expect(cleared.value.realm.presentation).toEqual(emptyRealmPresentation);
        }
      }
      await seed({ pool: database.pool, admin: database.admin }, population, { from: previous, to: scale });
      expect(await fixture.populationCounts(name)).toEqual({ realms: scale, media: scale });
    },
    async warmup() {
      const current = await fixture.read(warmup.realmId);
      const result = await fixture.patch(
        warmup.realmId,
        current.headRevisionId,
        warmupSelection,
        `growth-warmup-${changes}-${randomUUID()}`,
      );
      expect(result.response.status).toBe(200);
    },
    async prepare(_database, _scale) {
      const current = await fixture.read(target.realmId);
      expect(current.presentation).toEqual(emptyRealmPresentation);
      prepared = { expectedHead: current.headRevisionId, key: `growth-selected-${randomUUID()}` };
    },
    async operation(_database, scale) {
      if (!prepared) throw new Error('Realm presentation selected command was not prepared');
      const input = { ...prepared };
      prepared = undefined;
      const result = await fixture.patch(target.realmId, input.expectedHead, selection, input.key);
      expect(result.response.status).toBe(200);
      const revisionId = result.value.realm.headRevisionId as string;
      expect(result.value.realm.presentation).toEqual(selection);
      commands.push({ realmId: target.realmId, ...input, revisionId, presentation: selection });
      return { scale, revisionId };
    },
  });
  expectPhysicalSample(report);
  expect(report.samples.map(claimUpdateCount)).toEqual([changes, changes, changes]);
  for (const command of commands) await assertSuccessfulBinding(command);
  return { report, commands, selection };
}

async function verifyReplayAndNewCommand(
  series: { commands: MeasuredCommand[]; selection: RealmPresentationInput },
  target: GrowthRealm,
  assetIds: readonly string[],
): Promise<MeasuredCommand> {
  const last = series.commands.at(-1)!;
  const beforeReplay = await fixture.revisionCount(target.realmId);
  expect(await fixture.receiptCount([last.key])).toBe(1);
  const replay = await fixture.patch(target.realmId, last.expectedHead, series.selection, last.key);
  expect(replay.response.status).toBe(200);
  expect(replay.value.realm.headRevisionId).toBe(last.revisionId);
  expect(await fixture.revisionCount(target.realmId)).toBe(beforeReplay);
  expect(await fixture.receiptCount([last.key])).toBe(1);

  const before = await fixture.read(target.realmId);
  const claimsBefore = await fixture.mediaRows(assetIds);
  const key = `new-command-${randomUUID()}`;
  const next = await fixture.patch(target.realmId, before.headRevisionId, series.selection, key);
  expect(next.response.status).toBe(200);
  const revisionId = next.value.realm.headRevisionId as string;
  expect(revisionId).not.toBe(before.headRevisionId);
  expect(await fixture.revisionCount(target.realmId)).toBe(beforeReplay + 1);
  expect(await fixture.receiptCount([key])).toBe(1);
  const command = {
    realmId: target.realmId,
    expectedHead: before.headRevisionId,
    key,
    revisionId,
    presentation: series.selection,
  };
  await assertSuccessfulBinding(command);
  const claimsAfter = await fixture.mediaRows(assetIds);
  expect(claimsAfter.map(({ claimed_realm_id, claimed_at }) => [claimed_realm_id, claimed_at])).toEqual(
    claimsBefore.map(({ claimed_realm_id, claimed_at }) => [claimed_realm_id, claimed_at]),
  );
  return command;
}

async function assertClearRetainsOldClaims(command: MeasuredCommand, assetIds: readonly string[]) {
  const before = await fixture.mediaRows(assetIds);
  const clearFrom = await fixture.read(command.realmId);
  const cleared = await fixture.patch(
    command.realmId,
    clearFrom.headRevisionId,
    emptyRealmPresentation,
    `growth-clear-terminal-${randomUUID()}`,
  );
  expect(cleared.response.status).toBe(200);
  expect(cleared.value.realm.presentation).toEqual(emptyRealmPresentation);
  const after = await fixture.mediaRows(assetIds);
  expect(after.map(({ claimed_realm_id, claimed_at }) => [claimed_realm_id, claimed_at])).toEqual(
    before.map(({ claimed_realm_id, claimed_at }) => [claimed_realm_id, claimed_at]),
  );
  const retained = await fixture.commandBinding(command.realmId, command.key, command.revisionId);
  expect(retained).toMatchObject({
    avatar_media_id: command.presentation.avatarMediaId,
    banner_media_id: command.presentation.bannerMediaId,
  });
  expect(after.every((row) => row.claimed_realm_id === command.realmId && row.claimed_at !== null)).toBe(true);
}

async function historySeries(
  target: GrowthRealm,
  icon: RealmPresentationAsset,
  banner: RealmPresentationAsset,
  warmup: GrowthRealm,
  warmupIcon: RealmPresentationAsset,
  warmupBanner: RealmPresentationAsset,
) {
  const selection = presentationFor(2, icon, banner);
  const warmupSelection = presentationFor(2, warmupIcon, warmupBanner);
  const prefix = `realm-presentation-history-${randomUUID()}`;
  const historyKeys: string[] = [];
  const measured: MeasuredCommand[] = [];
  let prepared: { expectedHead: string; key: string } | undefined;
  const report = await checkGrowth(fixture.base.db, {
    name: 'Realm presentation claim against retained settings/revision/receipt history',
    rule: 'series',
    scales,
    bounds,
    repetitions: 1,
    async grow(_database, scale) {
      const currentRows = await fixture.revisionCount(target.realmId);
      const add = scale - currentRows;
      if (add > 0) {
        const keys = await fixture.appendHistory(target.realmId, prefix, historyKeys.length, historyKeys.length + add);
        historyKeys.push(...keys);
      }
      expect(await fixture.revisionCount(target.realmId)).toBe(scale);
      const retainedReceipts = [...historyKeys, ...measured.map(({ key }) => key)];
      expect(retainedReceipts.length).toBe(scale - 1);
      expect(await fixture.receiptCount(retainedReceipts)).toBe(scale - 1);
      expect((await fixture.read(target.realmId)).presentation).toEqual(emptyRealmPresentation);
    },
    async warmup() {
      const current = await fixture.read(warmup.realmId);
      const result = await fixture.patch(
        warmup.realmId,
        current.headRevisionId,
        warmupSelection,
        `growth-history-warmup-${randomUUID()}`,
      );
      expect(result.response.status).toBe(200);
    },
    async prepare() {
      const current = await fixture.read(target.realmId);
      expect(current.presentation).toEqual(emptyRealmPresentation);
      prepared = { expectedHead: current.headRevisionId, key: `growth-history-selected-${randomUUID()}` };
    },
    async operation(_database, scale) {
      if (!prepared) throw new Error('Realm history selected command was not prepared');
      const input = { ...prepared };
      prepared = undefined;
      const result = await fixture.patch(target.realmId, input.expectedHead, selection, input.key);
      expect(result.response.status).toBe(200);
      const revisionId = result.value.realm.headRevisionId as string;
      expect(result.value.realm.presentation).toEqual(selection);
      const command = { realmId: target.realmId, ...input, revisionId, presentation: selection };
      measured.push(command);
      return { scale, revisionId };
    },
  });
  expectPhysicalSample(report);
  expect(report.samples.map(claimUpdateCount)).toEqual([2, 2, 2]);
  for (const command of measured) await assertSuccessfulBinding(command);
  return { report, commands: measured, selection };
}

test('native Realm presentation claims stay bounded across unrelated and retained-history growth', async () => {
  expect(fixture.actor.accountId).toBe(fixture.base.governor.accountId);
  expect([...fixture.actor.scopes].sort()).toEqual(fixture.admittedScopes);
  expect(fixture.actor.scopes).toContain('realm:manage');
  expect(fixture.actor.clientId).toBeTruthy();

  const warmupRealm = await fixture.createRealm('presentation claim warmup');
  const warmupIcon = await fixture.upload(warmupRealm.realmId, 'realm-icon');
  const warmupBanner = await fixture.upload(warmupRealm.realmId, 'realm-banner');
  const warmupAssets = [warmupIcon, warmupBanner];

  const zeroTarget = await fixture.createRealm('presentation claim zero');
  const oneTarget = await fixture.createRealm('presentation claim one');
  const oneIcon = await fixture.upload(oneTarget.realmId, 'realm-icon');
  const twoTarget = await fixture.createRealm('presentation claim two');
  const twoIcon = await fixture.upload(twoTarget.realmId, 'realm-icon');
  const twoBanner = await fixture.upload(twoTarget.realmId, 'realm-banner');

  const published = await fixture.mediaRows([warmupIcon.id, warmupBanner.id, oneIcon.id, twoIcon.id, twoBanner.id]);
  expect(published).toHaveLength(5);
  expect(published.every((row) => row.state === 'available' && row.variants > 0)).toBe(true);
  expect(published.every((row) => row.claimed_realm_id === null && row.claimed_at === null)).toBe(true);
  const expectedAssets = [
    [warmupIcon, 'realm-icon'],
    [warmupBanner, 'realm-banner'],
    [oneIcon, 'realm-icon'],
    [twoIcon, 'realm-icon'],
    [twoBanner, 'realm-banner'],
  ] as const;
  for (const [asset, purpose] of expectedAssets) {
    expect(published.find(({ media_id }) => media_id === asset.id)).toMatchObject({
      container_id: asset.realmId,
      uploader_id: fixture.actor.accountId,
      purpose,
      state: 'available',
    });
  }

  const zero = await commandSeries(0, zeroTarget, null, null, warmupRealm, null, null);
  const zeroNew = await verifyReplayAndNewCommand(zero, zeroTarget, []);
  expect(await fixture.mediaRows([])).toEqual([]);

  const one = await commandSeries(1, oneTarget, oneIcon, null, warmupRealm, warmupIcon, null);
  const oneNew = await verifyReplayAndNewCommand(one, oneTarget, [oneIcon.id]);
  expect(await fixture.mediaRows([oneIcon.id])).toMatchObject([
    { container_id: oneTarget.realmId, uploader_id: fixture.actor.accountId, purpose: 'realm-icon', state: 'available' },
  ]);
  await assertClearRetainsOldClaims(oneNew, [oneIcon.id]);

  const two = await commandSeries(2, twoTarget, twoIcon, twoBanner, warmupRealm, warmupIcon, warmupBanner);
  const twoNew = await verifyReplayAndNewCommand(two, twoTarget, [twoIcon.id, twoBanner.id]);
  await assertClearRetainsOldClaims(twoNew, [twoIcon.id, twoBanner.id]);

  const historyTarget = await fixture.createRealm('presentation claim history');
  const historyIcon = await fixture.upload(historyTarget.realmId, 'realm-icon');
  const historyBanner = await fixture.upload(historyTarget.realmId, 'realm-banner');
  const history = await historySeries(
    historyTarget,
    historyIcon,
    historyBanner,
    warmupRealm,
    warmupIcon,
    warmupBanner,
  );
  const historyNew = await verifyReplayAndNewCommand(history, historyTarget, [historyIcon.id, historyBanner.id]);
  await assertClearRetainsOldClaims(historyNew, [historyIcon.id, historyBanner.id]);

  const invalidTarget = await fixture.createRealm('presentation claim refusals');
  const foreignTarget = await fixture.createRealm('presentation claim foreign');
  const unavailable = await fixture.upload(invalidTarget.realmId, 'realm-icon', fixture.base.governor, false);
  const wrongPurpose = await fixture.upload(invalidTarget.realmId, 'realm-banner');
  const foreignRealm = await fixture.upload(foreignTarget.realmId, 'realm-icon');
  await fixture.base.grant(fixture.base.alice.accountId, invalidTarget.realmId, ['realm:manage']);
  const otherUploader = await fixture.upload(invalidTarget.realmId, 'realm-icon', fixture.base.alice);
  const refusals = [unavailable, wrongPurpose, foreignRealm, otherUploader] as const;

  const staleTarget = await fixture.createRealm('presentation claim stale CAS');
  const staleIcon = await fixture.upload(staleTarget.realmId, 'realm-icon');
  const staleBefore = await fixture.read(staleTarget.realmId);
  const moved = await fixture.patch(
    staleTarget.realmId,
    staleBefore.headRevisionId,
    emptyRealmPresentation,
    `growth-stale-mover-${randomUUID()}`,
  );
  expect(moved.response.status).toBe(200);
  const staleExpectedHead = staleBefore.headRevisionId;

  const refusalName = `realm-presentation-refusals-${randomUUID()}`;
  const refusalPopulation = await fixture.unrelatedPopulation(refusalName, invalidTarget.realmId);
  const refusalKeys: string[] = [];
  const invalidRevisionCount = await fixture.revisionCount(invalidTarget.realmId);
  const staleRevisionCount = await fixture.revisionCount(staleTarget.realmId);
  const invalidInitialHead = (await fixture.read(invalidTarget.realmId)).headRevisionId;
  const staleMovedHead = (await fixture.read(staleTarget.realmId)).headRevisionId;
  const refusalReport = await checkGrowth(fixture.base.db, {
    name: 'Realm presentation media_unavailable and stale CAS refusals including runner work',
    rule: 'series',
    scales,
    bounds,
    repetitions: 1,
    async grow(database, scale, previous) {
      await seed({ pool: database.pool, admin: database.admin }, refusalPopulation, { from: previous, to: scale });
      expect(await fixture.populationCounts(refusalName)).toEqual({ realms: scale, media: scale });
    },
    async prepare() {
      expect((await fixture.read(invalidTarget.realmId)).headRevisionId).toBe(invalidInitialHead);
      expect((await fixture.read(staleTarget.realmId)).headRevisionId).toBe(staleMovedHead);
    },
    async warmup() {
      await runRefusals();
    },
    async operation() {
      await runRefusals();
      return { refused: refusals.length + 1 };
    },
  });
  async function runRefusals() {
    const invalidHead = (await fixture.read(invalidTarget.realmId)).headRevisionId;
    for (const asset of refusals) {
      const key = `growth-refused-${randomUUID()}`;
      refusalKeys.push(key);
      const result = await fixture.patch(
        invalidTarget.realmId,
        invalidHead,
        { avatarMediaId: asset.id, bannerMediaId: null, rules: null },
        key,
      );
      expect(result.response.status).toBe(409);
      expect(result.value.code).toBe('media_unavailable');
    }
    const staleKey = `growth-stale-${randomUUID()}`;
    refusalKeys.push(staleKey);
    const stale = await fixture.patch(
      staleTarget.realmId,
      staleExpectedHead,
      { avatarMediaId: staleIcon.id, bannerMediaId: null, rules: null },
      staleKey,
    );
    expect(stale.response.status).toBe(412);
    expect(stale.value.code).toBe('precondition_failed');
  }
  expectPhysicalSample(refusalReport);
  expect(refusalReport.samples.every((sample) => sample.cost.statements > 0 && sample.cost.rows > 0)).toBe(true);
  expect(await fixture.revisionCount(invalidTarget.realmId)).toBe(invalidRevisionCount);
  expect(await fixture.revisionCount(staleTarget.realmId)).toBe(staleRevisionCount);
  expect((await fixture.read(invalidTarget.realmId)).headRevisionId).toBe(invalidInitialHead);
  expect((await fixture.read(staleTarget.realmId)).headRevisionId).toBe(staleMovedHead);
  expect(await Promise.all(refusalKeys.map((key) => fixture.keyExists(key)))).toEqual(
    refusalKeys.map(() => false),
  );
  const rejectedRows = await fixture.mediaRows(refusals.map(({ id }) => id).concat(staleIcon.id));
  expect(rejectedRows.every((row) => row.claimed_at === null && row.claimed_realm_id === null)).toBe(true);

  const twoCommand = two.commands.at(-1)!;
  const twoIds = [twoIcon.id, twoBanner.id];
  const currentTwo = await fixture.read(twoTarget.realmId);
  const orderKey = `growth-lock-order-${randomUUID()}`;
  const observer = observeSql(fixture.base.db.pool);
  let orderPatch: Awaited<ReturnType<typeof fixture.patch>> | undefined;
  try {
    orderPatch = await fixture.patch(twoTarget.realmId, currentTwo.headRevisionId, two.selection, orderKey);
  } finally {
    await observer.close();
  }
  expect(orderPatch).toBeDefined();
  expect(orderPatch!.response.status).toBe(200);
  const claimExecutions = observer.records.filter(({ statement }) => /\bUPDATE\s+content\.media\b/i.test(statement));
  expect(claimExecutions).toHaveLength(2);
  const observedIds = claimExecutions.map(({ parameters }) => twoIds.find((id) => parameters.includes(id)));
  expect(observedIds).toEqual([...twoIds].sort());

  await assertSuccessfulBinding({
    realmId: twoTarget.realmId,
    expectedHead: currentTwo.headRevisionId,
    key: orderKey,
    revisionId: orderPatch!.value.realm.headRevisionId,
    presentation: two.selection,
  });
  expect(twoCommand.revisionId).not.toBe(orderPatch!.value.realm.headRevisionId);
  expect(zeroNew.revisionId).toBeTruthy();
});
