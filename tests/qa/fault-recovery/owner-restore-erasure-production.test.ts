import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import * as admission from '../../../services/main/src/modules/access/admission.ts';
import {
  CommandOutcomeUnknown,
  type CommandResult,
} from '../../../services/main/src/infrastructure/fuseki.ts';
import {
  AccessAdmissionRegistry,
  AdmissionUnavailable,
} from '../../../services/main/src/modules/access/admission.ts';
import { ContentCore } from '../../../services/content/src/core.ts';
import { journalErasure, readErasure } from '../../../services/main/src/modules/erasure/journal.ts';
import { ReceiptCustody } from '../../../services/main/src/modules/outbox/receipt-custody.ts';
import { retainRecoveryCoverageHead } from '../../../services/main/src/modules/outbox/recovery-coverage-head.ts';
import { DATASET, GRAPHS, RV, hash } from '../../../services/main/src/modules/work/activate.ts';
import { RestoreLineageConflict } from '../../../services/main/src/modules/work/restore-lineage.ts';
import {
  scanAccessOutbox,
  scanAccessState,
} from '../../../services/main/src/modules/work/access-recovery-coverage.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { RecoveryBudget } from '../../../scripts/ops/recovery-set.ts';
import {
  finishOperatorRestore,
  type OperatorRestoreReleaseContext,
} from '../../../scripts/ops/restore.ts';
import { ownerRestoreErasureFixture, restoreKey } from './owner-restore-erasure-fixture.ts';

type Fixture = Awaited<ReturnType<typeof ownerRestoreErasureFixture>>;
type Copy = Awaited<ReturnType<Fixture['copy']>>;

function operatorContext(fixture: Fixture, copy: Copy): OperatorRestoreReleaseContext {
  return {
    budget: new RecoveryBudget(),
    fuseki: copy.fuseki,
    apps: {
      MAIN_DATA_EPOCH: copy.lineage.dataEpoch,
      MAIN_ROUTING_EPOCH: copy.lineage.routingEpoch,
    },
    manifest: {
      sealedCoverage: fixture.authority.sealedCoverage,
      sealedDeletionSets: [],
      fenceGeneration: fixture.generation,
    },
    pools: copy.owners,
  };
}

async function ownerLogins(copy: Copy) {
  return (
    await copy.owners.account.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname IN ('account','access','content','relay') ORDER BY rolname",
    )
  ).rows;
}

async function contentEpochs(copy: Copy) {
  return (
    await copy.owners.content.query<{ reading: string; authors: string }>(
      `SELECT (SELECT version::text FROM reading_position.generation WHERE singleton) AS reading,
      (SELECT version::text FROM source.author_name_epoch WHERE singleton) AS authors`,
    )
  ).rows[0]!;
}

async function insertDeliveringLease(
  fixture: Fixture,
  client: PoolClient,
  kind: 'search' | 'download',
  generation: string,
) {
  const table = kind === 'search' ? 'access.search_read_lease' : 'access.download_read_lease';
  const row = await client.query(
    `INSERT INTO ${table}
    SELECT cloned.* FROM ${table} AS template
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${table},
      to_jsonb(template) || jsonb_build_object('id',$1::text,'recovery_generation',$2::text,
        'created_at',clock_timestamp(),'expires_at',clock_timestamp()+interval '1 minute',
        'state','delivering','delivery_started_at',clock_timestamp(),'finished_at',NULL)) AS cloned
    WHERE template.id=$3::uuid RETURNING id,state`,
    [randomUUID(), generation, fixture.leaseTemplates[kind]],
  );
  expect(row.rows).toEqual([{ id: expect.any(String), state: 'delivering' }]);
}

async function assertHeld(fixture: Fixture, copy: Copy) {
  expect((await copy.ready()).status).toBe(503);
  expect(
    (
      await copy.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
    <${DATASET}> rv:dataEpoch "${copy.lineage.dataEpoch}" ; rv:routingEpoch "${copy.lineage.routingEpoch}" ;
      rv:sequence 0 ; rv:restoreHold true . } }`)
    ).boolean,
  ).toBe(true);
  expect(
    (
      await copy.owners.access.query<{ open: boolean; generation: string }>(
        'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
      )
    ).rows,
  ).toEqual([{ open: false, generation: fixture.generation }]);
  await expect(
    new AccessAdmissionRegistry(copy.owners.access).activePrincipalId(fixture.principal),
  ).rejects.toBeInstanceOf(AdmissionUnavailable);
}

async function expectHeldOperation(fixture: Fixture, copy: Copy, label = 'held-guard') {
  const key = randomUUID();
  const response = await copy.request(key);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { state: string; disposition: string };
  expect(body.state).toBe('held');
  expect(['unavailable', 'corrupt', 'conflict']).toContain(body.disposition);
  const held = (
    await copy.retainedRelay.query<{ hold_reason: string }>(
      'SELECT hold_reason FROM relay.owner_reconciliation WHERE operation_id=$1',
      ['owner:reconcile:' + key],
    )
  ).rows;
  expect(held).toHaveLength(1);
  console.info('owner restore erasure held', {
    case: label,
    reason: held[0]!.hold_reason?.slice(0, 500),
  });
  const epochs = await contentEpochs(copy);
  await expect(
    finishOperatorRestore(
      operatorContext(fixture, copy),
      {
        reconcile: (_context, body, key) => copy.request(key, undefined, body),
      },
      key,
      () => {},
    ),
  ).rejects.toThrow('Owner reconciliation did not verify the restore');
  expect(await contentEpochs(copy)).toEqual(epochs);
  expect((await ownerLogins(copy)).map((row) => row.rolcanlogin)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  await assertHeld(fixture, copy);
}

test(
  'OPS12: authenticated Owner restore uses retained erasures and exact retired custody before native graph and Access release',
  async () => {
    const fixtureStarted = Date.now();
    const fixture = await ownerRestoreErasureFixture();
    try {
      // Replaying attempts use isolated copies of one physical owner and graph
      // cut, each with a separately retained current relay.
      fixture.stopOriginal();
      await expect(fixture.native.query('ASK {}')).rejects.toThrow();
      const good = await fixture.copy();
      const transactions: { pid: string; txid: string; isolation: string }[] = [];
      const commands: CommandResult[] = [];
      const originalHistorical = ReceiptCustody.prototype.readHistorical;
      const historical = spyOn(ReceiptCustody.prototype, 'readHistorical').mockImplementation(
        async function (this: ReceiptCustody, position, client) {
          const identity = `SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid,
          current_setting('transaction_isolation') AS isolation`;
          const before = (
            await client.query<{ pid: string; txid: string; isolation: string }>(identity)
          ).rows[0]!;
          const query = spyOn(client, 'query');
          let result;
          try {
            result = await originalHistorical.call(this, position, client);
            for (const call of query.mock.calls)
              expect(String(call[0])).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i);
          } finally {
            query.mockRestore();
          }
          expect((await client.query(identity)).rows[0]).toEqual(before);
          transactions.push(before);
          return result;
        },
      );
      const maintenance = good.resources.erasures!.maintenance;
      const nativeCommand = maintenance.command.bind(maintenance);
      const native = spyOn(maintenance, 'command').mockImplementation(async (envelope) => {
        const result = await nativeCommand(envelope);
        commands.push(result);
        return result;
      });
      const actualGraphCommand = good.fuseki.commandWithReceipt.bind(good.fuseki);
      let lostGraphResponse = false;
      const lost = spyOn(good.fuseki, 'commandWithReceipt').mockImplementation(async (envelope) => {
        const result = await actualGraphCommand(envelope);
        if (envelope.receipt.startsWith('urn:rezics:receipt:restore-release:')) {
          expect(result.status).toBe('committed');
          lostGraphResponse = true;
          throw new CommandOutcomeUnknown('lost actual committed graph release response');
        }
        return result;
      });
      try {
        await assertHeld(fixture, good);
        expect((await good.request(randomUUID(), 'invalid-authentication')).status).toBe(401);
        await assertHeld(fixture, good);
        const copiedBytes = (
          await new ContentCore(good.owners.content).readExactBatch(
            [fixture.revisionId],
            async (ids) => new Set(ids),
          )
        )[0]!;
        expect(copiedBytes).toMatchObject({
          status: 'available',
          serializedJson: fixture.availableBeforeErasure.serializedJson,
          reference: {
            byteDigest: fixture.availableBeforeErasure.reference.byteDigest,
            byteLength: fixture.availableBeforeErasure.reference.byteLength,
          },
        });
        if (copiedBytes.status !== 'available')
          throw new Error('copied source bytes are unavailable');
        expect(hash(copiedBytes.serializedJson)).toBe(copiedBytes.reference.byteDigest);
        expect(Buffer.byteLength(copiedBytes.serializedJson, 'utf8')).toBe(
          copiedBytes.reference.byteLength,
        );
        let beforeReconcile = 0;
        let afterOwner: Awaited<ReturnType<typeof contentEpochs>> | undefined;
        await finishOperatorRestore(
          operatorContext(fixture, good),
          {
            reconcile: async (_context, body, key) => {
              const response = await good.request(key, undefined, body);
              expect(response.status).toBe(201);
              expect(await response.clone().json()).toMatchObject({
                kind: 'restore',
                state: 'reconciled',
                disposition: 'matched',
              });
              expect((await good.ready()).status).toBe(200);
              expect(
                (
                  await good.owners.access.query(
                    'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
                  )
                ).rows,
              ).toEqual([{ open: true, generation: (BigInt(fixture.generation) + 1n).toString() }]);
              expect(
                (
                  await good.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
                <${DATASET}> rv:dataEpoch "${good.lineage.dataEpoch}" ; rv:sequence 0 .
                FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
                ).boolean,
              ).toBe(true);
              expect((await ownerLogins(good)).map((row) => row.rolcanlogin)).toEqual([
                false,
                false,
                false,
                false,
              ]);
              afterOwner = await contentEpochs(good);
              return response;
            },
          },
          randomUUID(),
          () => {
            beforeReconcile++;
          },
        );
        expect(beforeReconcile).toBe(1);
        expect(lostGraphResponse).toBe(true);
        expect((await ownerLogins(good)).map((row) => row.rolcanlogin)).toEqual([
          true,
          true,
          true,
          true,
        ]);
        expect(await contentEpochs(good)).toEqual({
          reading: (BigInt(afterOwner!.reading) + 1n).toString(),
          authors: (BigInt(afterOwner!.authors) + 1n).toString(),
        });
        expect((await good.ready()).status).toBe(200);
        expect(
          (
            await good.owners.access.query<{ open: boolean; generation: string }>(
              'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
            )
          ).rows,
        ).toEqual([{ open: true, generation: (BigInt(fixture.generation) + 1n).toString() }]);
        expect(
          (
            await good.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
        <${DATASET}> rv:dataEpoch "${good.lineage.dataEpoch}" ; rv:sequence 0 .
        FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
          ).boolean,
        ).toBe(true);
        expect(
          (
            await good.fuseki.query(`PREFIX rv: <${RV}> ASK {
        VALUES ?reference { rv:revision rv:contentRevision }
        GRAPH <urn:rezics:search:public> { ?unit ?reference <urn:rezics:content:revision:${fixture.revisionId}> }
      }`)
          ).boolean,
        ).toBe(false);
        expect(
          (
            await new ContentCore(good.owners.content).readExactBatch(
              [fixture.revisionId],
              async (ids) => new Set(ids),
            )
          )[0],
        ).toMatchObject({ status: 'erased' });
        expect(
          (
            await good.owners.content.query(
              `SELECT graph_receipt,graph_data_epoch,graph_sequence::text
        FROM content.publication_erasure_supersession WHERE revision_id=$1 AND erasure_id=$2`,
              [fixture.revisionId, fixture.erased.erasureId],
            )
          ).rows,
        ).toEqual([
          {
            graph_receipt: fixture.original.receipt,
            graph_data_epoch: fixture.original.dataEpoch,
            graph_sequence: fixture.original.sequence,
          },
        ]);
        expect(
          commands.some(
            (result) =>
              result.status === 'committed' &&
              result.position.dataEpoch === good.lineage.dataEpoch &&
              result.position.sequence === '0',
          ),
        ).toBe(true);
        expect(transactions.length).toBeGreaterThan(0);
        expect(new Set(transactions.map((value) => `${value.pid}:${value.txid}`)).size).toBe(1);
        expect(transactions.every((value) => value.isolation === 'repeatable read')).toBe(true);
        for (const owner of [good.retainedRelay, ...Object.values(good.owners)]) {
          expect(owner.options.max).toBe(1);
          expect(owner.totalCount).toBeLessThanOrEqual(1);
          expect(owner.waitingCount).toBe(0);
        }
        for (const digest of [
          fixture.retired.payload_sha256,
          fixture.historicalManifest,
          fixture.historicalPayload,
          fixture.modelShape,
        ]) {
          expect(readFileSync(join(good.directory, digest))).toEqual(
            readFileSync(join(fixture.backupObjects, digest)),
          );
        }
        expect(
          (await readErasure(good.retainedRelay, fixture.erased.erasureId)).dispositions.find(
            (copy) => copy.domain === fixture.backupLabel,
          ),
        ).toMatchObject({ destruction: 'retained' });
        console.info('owner restore erasure case passed', { case: 'authenticated-owner-release' });
        console.info('owner restore erasure case passed', { case: 'operator-lost-release-ack' });
      } finally {
        lost.mockRestore();
        native.mockRestore();
        historical.mockRestore();
        await good.dispose();
      }

      const partial = await fixture.copy();
      const partialCommand = partial.fuseki.commandWithReceipt.bind(partial.fuseki);
      let graphCommitted = false;
      const committed = spyOn(partial.fuseki, 'commandWithReceipt').mockImplementation(
        async (envelope) => {
          const result = await partialCommand(envelope);
          if (envelope.receipt.startsWith('urn:rezics:receipt:restore-release:')) {
            expect(result.status).toBe('committed');
            graphCommitted = true;
          }
          return result;
        },
      );
      const failedAccess = spyOn(admission, 'releaseAccessRecoveryFence').mockImplementation(
        async () => {
          expect(graphCommitted).toBe(true);
          throw new RestoreLineageConflict(
            'interrupted after native graph release before Access CAS',
          );
        },
      );
      try {
        const epochs = await contentEpochs(partial);
        await expect(
          finishOperatorRestore(
            operatorContext(fixture, partial),
            {
              reconcile: (_context, body, key) => partial.request(key, undefined, body),
            },
            randomUUID(),
            () => {},
          ),
        ).rejects.toThrow('Owner reconciliation did not verify the restore');
        expect(graphCommitted).toBe(true);
        expect(
          (
            await partial.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.control}> {
          <${DATASET}> rv:dataEpoch "${partial.lineage.dataEpoch}" ; rv:sequence 0 .
          FILTER NOT EXISTS { <${DATASET}> rv:restoreHold true } } }`)
          ).boolean,
        ).toBe(true);
        expect(
          (
            await partial.owners.access.query<{ open: boolean; generation: string }>(
              'SELECT open,generation::text AS generation FROM access.recovery_fence WHERE id=true',
            )
          ).rows,
        ).toEqual([{ open: false, generation: fixture.generation }]);
        expect((await partial.ready()).status).toBe(503);
        await expect(
          new AccessAdmissionRegistry(partial.owners.access).activePrincipalId(fixture.principal),
        ).rejects.toBeInstanceOf(AdmissionUnavailable);
        expect((await ownerLogins(partial)).map((row) => row.rolcanlogin)).toEqual([
          false,
          false,
          false,
          false,
        ]);
        expect(await contentEpochs(partial)).toEqual(epochs);
        for (const owner of [partial.retainedRelay, ...Object.values(partial.owners)]) {
          expect(owner.options.max).toBe(1);
          expect(owner.totalCount).toBeLessThanOrEqual(1);
          expect(owner.waitingCount).toBe(0);
        }
        console.info('owner restore erasure case passed', {
          case: 'post-graph-access-interruption',
        });
      } finally {
        failedAccess.mockRestore();
        committed.mockRestore();
        await partial.dispose();
      }
      // These faults all reject before a held native write. Restore exact
      // captured bytes and rows between attempts so one C0 remains reusable.
      const shared = await fixture.copy();
      const sharedMaintenance = shared.resources.erasures!.maintenance;
      const heldCommands = spyOn(sharedMaintenance, 'command');
      const graphCommands = spyOn(shared.fuseki, 'commandWithReceipt');
      try {
        const indexedUnits = async () =>
          (
            await shared.fuseki.query(
              'PREFIX rv: <' +
                RV +
                '> SELECT ?unit ?reference WHERE {' +
                ' VALUES ?reference { rv:revision rv:contentRevision }' +
                ' GRAPH <urn:rezics:search:public> { ?unit ?reference' +
                ' <urn:rezics:content:revision:' +
                fixture.revisionId +
                '> }' +
                ' } ORDER BY ?unit ?reference LIMIT 65',
            )
          ).results?.bindings ?? [];
        const contentState = () =>
          new ContentCore(shared.owners.content).readExactBatch(
            [fixture.revisionId],
            async (ids) => new Set(ids),
          );
        const unitsBefore = await indexedUnits();
        expect(unitsBefore.length).toBeGreaterThan(0);
        expect(unitsBefore.length).toBeLessThanOrEqual(64);
        const contentBefore = await contentState();
        expect(contentBefore[0]).toMatchObject({ status: 'available' });
        const assertAccessBase = async () => {
          const client = await shared.owners.access.connect();
          try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            expect(await scanAccessState(client)).toEqual({
              count: fixture.coverage.accessStateCount,
              digest: fixture.coverage.accessStateDigest,
            });
            expect(await scanAccessOutbox(client)).toEqual({
              count: fixture.coverage.accessOutboxCount,
              digest: fixture.coverage.accessOutboxDigest,
            });
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        const faultAccess = async (sql: string, values: unknown[]) => {
          const client = await shared.owners.access.connect();
          try {
            await client.query('BEGIN');
            // Isolate the captured gate fault from unrelated projection dirty
            // markers; the runtime request sees the committed real gate row.
            await client.query('SET LOCAL session_replication_role = replica');
            const result = await client.query(sql, values);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        await assertAccessBase();
        const controlledFault = async (
          label: string,
          mutate: () => void | Promise<void>,
          restore: () => void | Promise<void>,
        ) => {
          heldCommands.mockClear();
          graphCommands.mockClear();
          await mutate();
          try {
            await expectHeldOperation(fixture, shared, label);
            expect(await indexedUnits()).toEqual(unitsBefore);
            expect(await contentState()).toEqual(contentBefore);
            expect(heldCommands.mock.calls).toHaveLength(0);
            expect(graphCommands.mock.calls).toHaveLength(0);
            for (const owner of [shared.retainedRelay, ...Object.values(shared.owners)]) {
              expect(owner.options.max).toBe(1);
              expect(owner.totalCount).toBeLessThanOrEqual(1);
              expect(owner.waitingCount).toBe(0);
            }
          } finally {
            await restore();
          }
          await assertHeld(fixture, shared);
          expect(await indexedUnits()).toEqual(unitsBefore);
          expect(await contentState()).toEqual(contentBefore);
          await assertAccessBase();
          console.info('owner restore erasure case passed', { case: label });
        };
        let interruptedAttempts = 0;
        await controlledFault(
          'pre-native-replay-interruption',
          () => {
            shared.resources.erasures!.maintenance = {
              command: async () => {
                interruptedAttempts++;
                throw new CommandOutcomeUnknown('interrupted before held native erasure request');
              },
            };
          },
          () => {
            shared.resources.erasures!.maintenance = sharedMaintenance;
            expect(interruptedAttempts).toBeGreaterThan(0);
          },
        );

        let changedGeneration = false;
        const originalHistorical = ReceiptCustody.prototype.readHistorical;
        const drift = spyOn(ReceiptCustody.prototype, 'readHistorical').mockImplementation(
          async function (this: ReceiptCustody, position, client) {
            const source = await originalHistorical.call(this, position, client);
            if (!changedGeneration) {
              await client.query(
                'UPDATE access.recovery_fence SET generation=generation+1 WHERE id=true',
              );
              changedGeneration = true;
            }
            return source;
          },
        );
        await controlledFault(
          'held-access-generation-drift',
          () => {},
          () => {
            drift.mockRestore();
            expect(changedGeneration).toBe(true);
          },
        );

        const originalCommand = readFileSync(
          join(shared.directory, fixture.retired.payload_sha256),
        );
        await controlledFault(
          'borrowed-historical-custody-failure',
          async () => {
            unlinkSync(join(shared.directory, fixture.retired.payload_sha256));
            const client = await shared.owners.access.connect();
            try {
              await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
              await client.query('SELECT open FROM access.recovery_fence WHERE id=true FOR UPDATE');
              const identity = 'SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid';
              const before = (await client.query(identity)).rows;
              await expect(
                shared.custody.readHistorical(
                  {
                    dataEpoch: fixture.retired.data_epoch,
                    streamSequence: fixture.retired.stream_sequence,
                  },
                  client,
                ),
              ).rejects.toThrow();
              expect((await client.query(identity)).rows).toEqual(before);
              expect(shared.owners.access.totalCount).toBe(1);
              expect(shared.owners.access.waitingCount).toBe(0);
            } finally {
              await client.query('ROLLBACK');
              client.release();
            }
          },
          () =>
            writeFileSync(join(shared.directory, fixture.retired.payload_sha256), originalCommand),
        );
        const headSql =
          'SELECT generation::text,coverage_digest,to_jsonb(head) AS original FROM relay.recovery_coverage_head head WHERE consumer=$1';
        const originalHead = (
          await shared.retainedRelay.query<{
            generation: string;
            coverage_digest: string;
            original: object;
          }>(headSql, [fixture.coverage.relay.consumer])
        ).rows;
        expect(originalHead).toHaveLength(1);
        expect(originalHead[0]!.generation).toBe('1');
        const authoritySql =
          'SELECT coverage_generation::text,revision::text,coverage_digest,to_jsonb(authority) AS original FROM relay.current_authority_coverage authority WHERE id=true';
        const originalAuthority = (
          await shared.retainedRelay.query<{
            coverage_generation: string;
            revision: string;
            coverage_digest: string;
            original: object;
          }>(authoritySql)
        ).rows;
        expect(originalAuthority).toHaveLength(1);
        expect(originalAuthority[0]!.coverage_generation).toBe('1');
        await controlledFault(
          'newer-retained-frontier',
          async () => {
            await retainRecoveryCoverageHead(
              shared.retainedRelay,
              fixture.newerAuthority.sealedCoverage,
              restoreKey,
            );
            const current = (
              await shared.retainedRelay.query(headSql, [fixture.coverage.relay.consumer])
            ).rows;
            expect(current).toHaveLength(1);
            expect(current[0]!.generation).toBe('2');
            expect(current[0]!.coverage_digest).not.toBe(originalHead[0]!.coverage_digest);
            const authority = (await shared.retainedRelay.query(authoritySql)).rows;
            expect(authority).toHaveLength(1);
            expect(authority[0]!.coverage_generation).toBe('2');
            expect(authority[0]!.revision).toBe(
              (BigInt(originalAuthority[0]!.revision) + 1n).toString(),
            );
            expect(authority[0]!.coverage_digest).toBe(current[0]!.coverage_digest);
            expect(authority[0]!.coverage_digest).not.toBe(originalAuthority[0]!.coverage_digest);
          },
          async () => {
            expect(
              (
                await shared.faultRetained([
                  { sql: 'DELETE FROM relay.current_authority_coverage WHERE id=true' },
                  {
                    sql: 'DELETE FROM relay.recovery_coverage_head WHERE consumer=$1',
                    values: [fixture.coverage.relay.consumer],
                  },
                  {
                    sql: 'INSERT INTO relay.recovery_coverage_head SELECT * FROM jsonb_populate_record(NULL::relay.recovery_coverage_head,$1::jsonb)',
                    values: [JSON.stringify(originalHead[0]!.original)],
                  },
                  {
                    sql: 'INSERT INTO relay.current_authority_coverage SELECT * FROM jsonb_populate_record(NULL::relay.current_authority_coverage,$1::jsonb)',
                    values: [JSON.stringify(originalAuthority[0]!.original)],
                  },
                ])
              ).rowCount,
            ).toBe(1);
            expect(
              (await shared.retainedRelay.query(headSql, [fixture.coverage.relay.consumer])).rows,
            ).toEqual(originalHead);
            expect((await shared.retainedRelay.query(authoritySql)).rows).toEqual(
              originalAuthority,
            );
          },
        );
        const originalManifest = readFileSync(join(shared.directory, fixture.historicalManifest));
        await controlledFault(
          'missing-historical-manifest',
          () => unlinkSync(join(shared.directory, fixture.historicalManifest)),
          () => writeFileSync(join(shared.directory, fixture.historicalManifest), originalManifest),
        );
        const originalShape = readFileSync(join(shared.directory, fixture.modelShape));
        await controlledFault(
          'corrupt-historical-shape',
          () => writeFileSync(join(shared.directory, fixture.modelShape), 'corrupt original shape'),
          () => writeFileSync(join(shared.directory, fixture.modelShape), originalShape),
        );

        const eventSql =
          "SELECT to_jsonb(event) AS original FROM relay.delivered_event event WHERE envelope->'data'->'receipt'->>'id'=$1";
        const event = (await shared.retainedRelay.query(eventSql, [fixture.original.receipt])).rows;
        expect(event).toHaveLength(1);
        const restoreEvent = async () => {
          await shared.faultRetained(
            "DELETE FROM relay.delivered_event WHERE envelope->'data'->'receipt'->>'id'=$1",
            [fixture.original.receipt],
          );
          expect(
            (
              await shared.faultRetained(
                'INSERT INTO relay.delivered_event SELECT * FROM jsonb_populate_record(NULL::relay.delivered_event,$1::jsonb)',
                [JSON.stringify(event[0]!.original)],
              )
            ).rowCount,
          ).toBe(1);
          expect(
            (await shared.retainedRelay.query(eventSql, [fixture.original.receipt])).rows,
          ).toEqual(event);
        };
        await controlledFault(
          'missing-retained-native-event',
          async () => {
            expect(
              (
                await shared.faultRetained(
                  "DELETE FROM relay.delivered_event WHERE envelope->'data'->'receipt'->>'id'=$1",
                  [fixture.original.receipt],
                )
              ).rowCount,
            ).toBe(1);
          },
          restoreEvent,
        );
        await controlledFault(
          'corrupt-retained-native-proof',
          async () => {
            expect(
              (
                await shared.faultRetained(
                  "UPDATE relay.delivered_event SET envelope=jsonb_set(envelope,'{data,receipt,systemProof,erasureEpoch}',to_jsonb($2::text)) WHERE envelope->'data'->'receipt'->>'id'=$1",
                  [fixture.original.receipt, (BigInt(fixture.erased.erasureEpoch) + 1n).toString()],
                )
              ).rowCount,
            ).toBe(1);
          },
          restoreEvent,
        );

        const gate = 'work:edit:' + fixture.work;
        const epoch = (
          await shared.owners.access.query<{ epoch: string; original: object }>(
            'SELECT authority_epoch::text AS epoch,to_jsonb(gate) AS original FROM access.scope_gate gate WHERE id=$1',
            [gate],
          )
        ).rows;
        expect(epoch).toHaveLength(1);
        await controlledFault(
          'stale-restored-access-authority',
          async () => {
            expect(
              (
                await faultAccess(
                  'UPDATE access.scope_gate SET authority_epoch=authority_epoch+1 WHERE id=$1',
                  [gate],
                )
              ).rowCount,
            ).toBe(1);
          },
          async () => {
            expect(
              (
                await faultAccess(
                  'UPDATE access.scope_gate SET authority_epoch=$2::bigint WHERE id=$1',
                  [gate, epoch[0]!.epoch],
                )
              ).rowCount,
            ).toBe(1);
            expect(
              (
                await shared.owners.access.query(
                  'SELECT authority_epoch::text AS epoch,to_jsonb(gate) AS original FROM access.scope_gate gate WHERE id=$1',
                  [gate],
                )
              ).rows,
            ).toEqual(epoch);
          },
        );
      } finally {
        graphCommands.mockRestore();
        heldCommands.mockRestore();
        await shared.dispose();
      }

      const newerJournal = await fixture.copy();
      try {
        await journalErasure(newerJournal.retainedRelay, {
          operationId: randomUUID(),
          requestDigest: '17'.repeat(32),
          kind: 'revision',
          principalId: fixture.principalId,
          admissionId: randomUUID(),
          authorityEpoch: fixture.generation,
          targets: [{ kind: 'content_revision', ref: fixture.laterRevisionId }],
        });
        await expectHeldOperation(fixture, newerJournal);
        console.info('owner restore erasure case passed', { case: 'newer-erasure-journal' });
      } finally {
        await newerJournal.dispose();
      }

      for (const kind of ['search', 'download'] as const) {
        const copy = await fixture.copy();
        let inserted = false;
        const lock = admission.lockAccessRecoveryFenceForRelease;
        const veto = spyOn(admission, 'lockAccessRecoveryFenceForRelease').mockImplementation(
          async (client, generation) => {
            await lock(client, generation);
            await insertDeliveringLease(fixture, client, kind, generation);
            inserted = true;
          },
        );
        const commands = spyOn(copy.fuseki, 'commandWithReceipt');
        try {
          await expectHeldOperation(fixture, copy);
          expect(inserted).toBe(true);
          expect(
            commands.mock.calls.some((call) => call[0].update.includes('restore-release')),
          ).toBe(false);
          expect(
            (
              await copy.owners.access.query(`SELECT count(*)::text AS count
            FROM ${kind === 'search' ? 'access.search_read_lease' : 'access.download_read_lease'}
            WHERE state='delivering'`)
            ).rows,
          ).toEqual([{ count: '0' }]);
          console.info('owner restore erasure case passed', {
            case: 'delivering-' + kind + '-lease',
          });
        } finally {
          commands.mockRestore();
          veto.mockRestore();
          await copy.dispose();
        }
      }
    } finally {
      await fixture.close();
      const elapsedMs = Date.now() - fixtureStarted;
      console.info('owner restore erasure fixture finished', { elapsedMs });
      expect(elapsedMs).toBeLessThan(600_000);
    }
  },
  qaStartupTestTimeout(600_000),
);
