import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { DATASET, GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { qaStartupTestTimeout } from '../../../scripts/qa/stack-startup.ts';
import { ownerRestoreErasureFixture, restoreKey } from './owner-restore-erasure-fixture.ts';

type Fixture = Awaited<ReturnType<typeof ownerRestoreErasureFixture>>;
type Copy = Awaited<ReturnType<Fixture['copy']>>;

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

async function expectHeldOperation(fixture: Fixture, copy: Copy) {
  const response = await copy.request();
  expect(response.status).toBe(201);
  const body = (await response.json()) as { state: string; disposition: string };
  expect(body.state).toBe('held');
  expect(['unavailable', 'corrupt', 'conflict']).toContain(body.disposition);
  await assertHeld(fixture, copy);
}

test(
  'OPS12: authenticated Owner restore uses retained erasures and exact retired custody before native graph and Access release',
  async () => {
    const fixture = await ownerRestoreErasureFixture();
    try {
      // Each adverse state gets an independent copy of the same physical owner
      // cut and graph bytes, plus its own separately retained current relay.
      for (const missing of [
        fixture.retired.payload_sha256,
        fixture.historicalManifest,
        fixture.historicalPayload,
        fixture.modelShape,
      ]) {
        const copy = await fixture.copy();
        try {
          unlinkSync(join(copy.directory, missing));
          await expectHeldOperation(fixture, copy);
        } finally {
          await copy.dispose();
        }
      }
      for (const corrupt of [fixture.retired.payload_sha256, fixture.modelShape]) {
        const copy = await fixture.copy();
        try {
          writeFileSync(join(copy.directory, corrupt), 'corrupt independently retained original');
          await expectHeldOperation(fixture, copy);
        } finally {
          await copy.dispose();
        }
      }
    for (const proof of ['missing', 'corrupt'] as const) {
      const copy = await fixture.copy({ originalProof: proof });
      try {
        await expectHeldOperation(fixture, copy);
        } finally {
          await copy.dispose();
        }
      }
      const staleAccess = await fixture.copy();
      try {
        const changed = await staleAccess.owners.access.query(
          `UPDATE access.scope_gate SET authority_epoch=authority_epoch+1
        WHERE id=$1`,
          [`work:edit:${fixture.work}`],
        );
        expect(changed.rowCount).toBe(1);
        await expectHeldOperation(fixture, staleAccess);
      } finally {
        await staleAccess.dispose();
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
      } finally {
        await newerJournal.dispose();
      }

      const newerFrontier = await fixture.copy();
      try {
        // This is another real full source capture, not a fabricated current
        // signature or a restored copy's claim about its own erasure absence.
        const current = await fixture.captureCurrentAuthority(newerFrontier.retainedRelay);
        await retainRecoveryCoverageHead(
          newerFrontier.retainedRelay,
          current.sealedCoverage,
          restoreKey,
        );
        await expectHeldOperation(fixture, newerFrontier);
      } finally {
        await newerFrontier.dispose();
      }

      const interrupted = await fixture.copy();
      try {
        interrupted.resources.erasures!.maintenance = {
          command: async () => {
            throw new CommandOutcomeUnknown('interrupted before held native erasure request');
          },
        };
        await expectHeldOperation(fixture, interrupted);
      } finally {
        await interrupted.dispose();
      }

      const borrowed = await fixture.copy();
      const client = await borrowed.owners.access.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await client.query('SELECT open FROM access.recovery_fence WHERE id=true FOR UPDATE');
        const identity = 'SELECT pg_backend_pid()::text AS pid,txid_current()::text AS txid';
        const before = (await client.query(identity)).rows;
        unlinkSync(join(borrowed.directory, fixture.retired.payload_sha256));
        await expect(
          borrowed.custody.readHistorical(
            {
              dataEpoch: fixture.retired.data_epoch,
              streamSequence: fixture.retired.stream_sequence,
            },
            client,
          ),
        ).rejects.toThrow();
        expect((await client.query(identity)).rows).toEqual(before);
        expect(borrowed.owners.access.totalCount).toBe(1);
        expect(borrowed.owners.access.waitingCount).toBe(0);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      try {
        await expectHeldOperation(fixture, borrowed);
      } finally {
        await borrowed.dispose();
      }

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
      try {
        await assertHeld(fixture, good);
        expect((await good.request(randomUUID(), 'invalid-authentication')).status).toBe(401);
        await assertHeld(fixture, good);
        expect(
          (
            await new ContentCore(good.owners.content).readExactBatch(
              [fixture.revisionId],
              async (ids) => new Set(ids),
            )
          )[0],
        ).toMatchObject({
          status: 'available',
          serializedJson: JSON.stringify({ body: 'erased native HTTP fixture payload' }),
        });
        const response = await good.request();
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({
          kind: 'restore',
          state: 'reconciled',
          disposition: 'matched',
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
      } finally {
        native.mockRestore();
        historical.mockRestore();
        await good.dispose();
      }
    } finally {
      await fixture.close();
    }
  },
  qaStartupTestTimeout(600_000),
);
