import { expect, setDefaultTimeout, test } from 'bun:test';
import permission from '../../src/access/permission-check.sql';
import readReceipt from '../../src/command/read-receipt.sql';
import completeStatement from '../../src/content/complete-media.sql';
import { newId } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, type GrowthReport } from '../support/growth.ts';
import { observeSql, permissionResourceId, type SqlExecution } from './support/sql-observer.ts';
import { completionFixture, recordObservations, type Axis, type Selection } from './support/growth-realm-media-completion-fixture.ts';

setDefaultTimeout(900_000);
const scales = [256, 1024, 4096] as const;

function assertAuthorization(records: readonly SqlExecution[], selected: Selection, replay: boolean) {
  const receipt = records.findIndex(({ statement }) => statement === readReceipt.sql);
  const complete = records.findIndex(({ statement }) => statement === completeStatement.sql);
  const checks = records.flatMap((execution, index) => execution.statement === permission.sql ? [{ execution, index }] : []);
  for (const [action, id] of [['media:complete', selected.id], ['realm:manage', selected.realmId]]) {
    const check = checks.find(({ execution }) => execution.parameters.includes(action) &&
      permissionResourceId(execution, permission.params) === id);
    expect(check).toBeDefined();
    if (receipt >= 0) expect(check!.index).toBeLessThan(receipt);
  }
  if (replay) { expect(receipt).toBeGreaterThanOrEqual(0); expect(complete).toBe(-1); }
}

function reportBound(report: GrowthReport) {
  recordObservations(report);
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.statementRepetitions.flat().length).toBeGreaterThan(0);
  }
  const growing = ['content.media', 'community.realm', 'community.realm_revision', 'access.resource_grant', 'core.receipt'];
  const measured = growing.filter((relation) => report.samples.every(({ cost }) => cost.relations[relation]));
  expect(measured).toContain('content.media');
  assertGrowthAccessPaths(report.name, report.samples, measured);
}

for (const axis of ['population', 'history'] as const satisfies readonly Axis[]) {
  test(`native Realm completion, replay, refusals and registered publication under independent ${axis} growth`, async () => {
    const f = await completionFixture();
    const trace = observeSql(f.base.db.pool);
    try {
      // A fixed pool covers warmups, accepted runs and the harness's four cold-backend discards per scale.
      // Every selected media row is admitted through native Realm reservation, never direct SQL.
      const fresh: Selection[] = [];
      for (let i = 0; i < 18; i++) fresh.push(await f.reserve(i % 2 ? 'realm-banner' : 'realm-icon'));
      const replay = await f.reserve('realm-banner');
      const pending = await f.reserve();
      const refusedReplay = await f.reserve('realm-banner');
      for (const selected of [replay, refusedReplay]) {
        expect((await f.complete(selected)).response.status).toBe(200);
        await f.assertState(selected, true);
      }
      // Bob has current media authority and Realm management; uploader identity still refuses him.
      // Grantor provisioning is setup only; the tested grants themselves go through native HTTP.
      await f.base.db.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
          VALUES ($1,$2,$3,'access:grant','(,)'::tstzrange,$4)`,
        [f.route, pending.id, f.base.governor.accountId, newId(f.route)],
      );
      await f.base.grant(f.base.bob.accountId, pending.id, ['media:complete']);
      await f.base.grant(f.base.bob.accountId, f.realmId, ['realm:manage']);
      let next = 0;
      const growth = (phase: string) => ({ name: `Realm media ${phase} with independent ${axis} growth`, scales,
        repetitions: 1, warmups: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const,
        byteBounds: { requestBytes: 'constant', responseBytes: 'constant' } as const,
        grow: (_db: unknown, scale: number, previous: number) => f.grow(axis, scale, previous) });

      reportBound(await checkGrowth(f.base.db, {
        ...growth('initial completion'),
        async operation() {
          const selected = fresh[next++];
          if (!selected) throw new Error('Initial-completion spare selections exhausted');
          await f.assertState(selected, false);
          const start = trace.records.length;
          const result = await f.complete(selected);
          expect(result.response.status).toBe(200);
          expect(result.value).toEqual({ media: { id: selected.id, state: 'uploaded' } });
          assertAuthorization(trace.records.slice(start), selected, false);
          expect(trace.records.slice(start).some(({ statement }) => statement === completeStatement.sql)).toBe(true);
          await f.assertState(selected, true);
        },
      }));
      const replayState = await f.assertState(replay, true);
      reportBound(await checkGrowth(f.base.db, {
        ...growth('valid replay'),
        async operation() {
          const start = trace.records.length;
          const result = await f.complete(replay);
          expect(result.response.status).toBe(200);
          expect(result.value).toEqual({ media: { id: replay.id, state: 'uploaded' } });
          assertAuthorization(trace.records.slice(start), replay, true);
          expect(await f.assertState(replay, true)).toEqual(replayState);
        },
      }));

      const pendingState = await f.assertState(pending, false);
      const refusedState = await f.assertState(refusedReplay, true);
      const badInputs = [
        ['wrong uploader', 403, f.input(pending), f.base.bob.websiteBearer],
        ['wrong reservation', 403, { ...f.input(pending), reservationRequestId: crypto.randomUUID() }],
        ['wrong same-route container', 403, { ...f.input(pending), containerId: newId(f.route) }],
        ['measured byte mismatch', 403, { ...f.input(pending), byteCount: f.input(pending).byteCount + 1 }],
        ['measured digest mismatch', 403, { ...f.input(pending), sha256: '0'.repeat(64) }],
        ['over 20 MiB', 400, { ...f.input(pending), byteCount: 20 * 1024 * 1024 + 1 }],
        ['malformed digest', 400, { ...f.input(pending), sha256: 'invalid' }],
      ] as const;
      reportBound(await checkGrowth(f.base.db, {
        ...growth('input and uploader refusals'),
        async operation() {
          for (const [label, status, body, bearer] of badInputs) {
            const start = trace.records.length;
            const result = await f.complete(pending, { key: crypto.randomUUID(), body, bearer });
            expect(result.response.status, label).toBe(status);
            expect(result.value.media, label).toBeUndefined();
            const records = trace.records.slice(start);
            // Schema rejection may occur before database admission; no invented database-work minimum.
            expect(records.some(({ statement }) => statement === completeStatement.sql), label).toBe(false);
            expect(records.some(({ statement }) => statement === readReceipt.sql), label).toBe(false);
          }
          expect(await f.snapshot(pending)).toEqual(pendingState);
        },
      }));

      await f.base.revoke(f.realmId, f.base.alice.accountId, ['realm:manage']);
      reportBound(await checkGrowth(f.base.db, {
        ...growth('revoked management completion and replay'),
        async operation() {
          // The completed reservation reuses its exact successful key, then also attempts a new key.
          for (const [selected, key] of [[pending, pending.completionKey],
            [refusedReplay, refusedReplay.completionKey], [refusedReplay, crypto.randomUUID()]] as const) {
            const start = trace.records.length;
            const result = await f.complete(selected, { key });
            expect(result.response.status).toBe(403);
            expect(result.value.media).toBeUndefined();
            const records = trace.records.slice(start);
            assertAuthorization(records, selected, false);
            expect(records.some(({ statement }) => statement === readReceipt.sql)).toBe(false);
            expect(records.some(({ statement }) => statement === completeStatement.sql)).toBe(false);
          }
          expect(await f.snapshot(pending)).toEqual(pendingState);
          expect(await f.snapshot(refusedReplay)).toEqual(refusedState);
        },
      }));
      await f.base.grant(f.base.alice.accountId, f.realmId, ['realm:manage']);

      // Publication is a separate observation with its real registered effect and Sharp workflow.
      // Completion above asserts uploaded with zero derivatives and makes no availability claim.
      await trace.close();
      await f.startPublication();
      let publication: Selection;
      async function preparePublication() {
        publication = await f.reserve();
        expect((await f.complete(publication)).response.status).toBe(200);
        await f.assertState(publication, true);
      }
      reportBound(await checkGrowth(f.base.db, {
        ...growth('registered image publication'),
        prepare: preparePublication,
        async warmup() { await preparePublication(); return f.publish(publication); },
        operation: () => f.publish(publication),
        counted: {
          read: (value) => value as { workflows: number; originals: number; variants: number },
          bounds: { workflows: 'constant', originals: 'constant', variants: 'constant' },
          limits: { workflows: 2, originals: 20 * 1024 * 1024, variants: 12 },
        },
      }));
    } finally {
      await trace.close();
      await f.close();
    }
  }, 900_000);
}
