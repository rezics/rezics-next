import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { decodeLocator, encodeLocator } from '../../src/history/contract/locator.ts';
import { commandHistoryKind } from '../../src/history/adapters/record.ts';
import type { HistoryArtifact, HistoryBarrier } from '../../src/history/contract/registry.ts';
import {
  readHistoryOwnerCoverage,
  readHistoryReceivingReceipt,
  verifyHistoryOwnerCoverage,
  verifyHistoryReceivingReceipt,
} from '../../src/history/adapters/receiving.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { readSemanticErasure } from '../../src/semantic/account-erasure.ts';
import {
  readSubjectErasureSourceProof,
  verifySubjectErasureSourceProof,
} from '../../src/semantic/account-erasure-source.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  assertGrowthAccessPaths,
  capture,
  checkGrowth,
  costOf,
  growthByteViolations,
  growthViolations,
  seed,
  type Cost,
} from '../support/growth.ts';
import { createBody } from '../zones/resource-fixture.ts';
import { unrelatedSemanticPopulation } from './planner-graph-fixtures.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';
import { accountErasureWorker } from './support/account-erasure-worker.ts';

const context = () => ({ deadline: Date.now() + 5000 });
const basis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'semantic-shared-erasure-growth',
  requestedBy: null,
};
type LocatorRow = {
  artifact_type: HistoryArtifact['locator']['artifactType'];
  locator: Buffer;
};

function allWork(cost: Cost) {
  expect(cost.requestBytes, 'Native request byte counter is required').toBeNumber();
  expect(cost.responseBytes, 'Native response byte counter is required').toBeNumber();
  const total = {
    ...cost,
    statements: cost.statements + cost.controlStatements + cost.catalogStatements + (cost.backgroundStatements ?? 0),
    rows: cost.rows + (cost.backgroundRows ?? 0),
    blocks: cost.blocks + (cost.backgroundBlocks ?? 0),
    requestBytes: cost.requestBytes! + (cost.backgroundRequestBytes ?? 0),
    responseBytes: cost.responseBytes! + (cost.backgroundResponseBytes ?? 0),
  };
  expect(total.statements).toBeLessThanOrEqual(100);
  expect(total.rows).toBeLessThanOrEqual(100);
  expect(total.requestBytes + total.responseBytes).toBeLessThanOrEqual(65536);
  return total;
}

// Read the installed inventories, including former roles and empty native homes. Neither an
// account role page nor a local erasure checkpoint supplies this population.
async function inventories(f: AccountErasureFixture, accountId: string) {
  const sourceKeys = new Set<string>();
  const artifacts: HistoryArtifact[] = [];
  const homes = new Set<number>([partitionOf(routeOf(accountId)!)]);
  for (let home = 0; home < 4096; home++) {
    let after = ['', '0', '', '0'];
    for (;;) {
      const page = await f.db.admin.query<{
        store: string;
        record_key: string;
        role: string;
        delivery_position: string;
      }>(
        `SELECT store,record_key::text,role,delivery_position::text FROM semantic.erasure_source_record
         WHERE partition_no=$1 AND account_id=$2
           AND (store,record_key,role,delivery_position)>($3,$4::bigint,$5,$6::bigint)
         ORDER BY store,record_key,role,delivery_position LIMIT 100`,
        [home, accountId, ...after],
      );
      for (const row of page.rows) {
        homes.add(home);
        sourceKeys.add([home, row.store, row.record_key, row.role, row.delivery_position].join(':'));
      }
      const last = page.rows.at(-1);
      if (!last || page.rows.length < 100) break;
      after = [last.store, last.record_key, last.role, last.delivery_position];
    }
    let type = '';
    let locator: Buffer = Buffer.alloc(0);
    for (;;) {
      const page = await f.db.admin.query<LocatorRow>(
        `SELECT artifact_type,locator FROM core.history_locator
         WHERE partition_no=$1 AND account_route=$2 AND account_id=$3
           AND (artifact_type,locator)>($4::text COLLATE "C",$5::bytea)
         ORDER BY artifact_type,locator LIMIT 100`,
        [home, routeOf(accountId), accountId, type, locator],
      );
      for (const row of page.rows) {
        homes.add(home);
        const scope = await f.db.admin.query<{ account_route: number; account_id: string; roles: number }>(
          `SELECT account_route,account_id,roles FROM core.history_locator
           WHERE partition_no=$1 AND artifact_type=$2 AND locator=$3
           ORDER BY account_route,account_id LIMIT 65`,
          [home, row.artifact_type, row.locator],
        );
        expect(scope.rows.length).toBeLessThanOrEqual(64);
        // Decode the actual producer's bytes and complete native scope; never construct a
        // supposedly successful artifact from a candidate id, current owner or local EOF.
        artifacts.push({
          partition: home,
          locator: decodeLocator(row.artifact_type, row.locator),
          accounts: scope.rows.map((r) => ({ accountRoute: r.account_route, accountId: r.account_id, roles: r.roles })),
        });
      }
      const last = page.rows.at(-1);
      if (!last || page.rows.length < 100) break;
      type = last.artifact_type;
      locator = last.locator;
    }
  }
  return { sourceKeys, artifacts, homes };
}

async function verifyPage(f: AccountErasureFixture, barrier: HistoryBarrier, artifact: HistoryArtifact) {
  const source = await readSubjectErasureSourceProof({ pool: f.db.pool }, barrier, context());
  expect(source, 'Native all-home/all-historical-role Subject Source terminal proof remains pending').not.toBeNull();
  const semantic = await readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'semantic', context());
  const zones = await readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'zones', context());
  if (semantic.state !== 'complete')
    throw new Error(`Native semantic History coverage pending: ${semantic.gaps.join(', ')}`);
  if (zones.state !== 'complete') throw new Error(`Native zones History coverage pending: ${zones.gaps.join(', ')}`);
  const receipt = await readHistoryReceivingReceipt({ pool: f.db.pool }, barrier, artifact, context());
  expect(
    receipt,
    `Native receiving custody pending: ${artifact.partition}:${Buffer.from(encodeLocator(artifact.locator)).toString('hex')}`,
  ).not.toBeNull();
  if (!source || !receipt) throw new Error('Native Source or receiving custody unavailable');
  const verified = await runCommand(
    f.db.pool,
    { partition: partitionOf(barrier.accountRoute), basis, deadline: Date.now() + 5000 },
    async (tx) =>
      noEffect(
        (await verifySubjectErasureSourceProof(tx, barrier, source)) &&
          (await verifyHistoryOwnerCoverage(tx, barrier, 'semantic', semantic.coverage)) &&
          (await verifyHistoryOwnerCoverage(tx, barrier, 'zones', zones.coverage)) &&
          (await verifyHistoryReceivingReceipt(tx, barrier, artifact, receipt)),
      ),
  );
  expect(verified.value, 'The same account-home native command must verify every independent proof').toBe(true);
  return { receivingArtifacts: 1 };
}

test('Original Semantic and Zone shared-erasure custody growth artifact counts real native Source coverage and receiving proof rather than local EOF', async () => {
  const f = await accountErasureFixture();
  let worker: Awaited<ReturnType<typeof accountErasureWorker>> | undefined;
  try {
    const owner = await f.author();
    const survivor = await f.author();
    await f.grant(GLOBAL_CONTEXT, survivor, ['context:accept', 'context:adopt']);
    await f.grant(GLOBAL_CONTEXT, owner, ['zone:create']);
    const created = await f.call(survivor, 'POST', '/v1/subjects', {
      type: 'schema:Person',
      labels: { en: 'Shared erasure growth original' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const subject = created.body.subject.id as string;
    const publicValue = `https://example.test/retained/${randomUUID()}`;
    const privateValue = accountAgentId(owner.accountId);
    const candidates: string[] = [];
    for (const [property, content] of [
      ['schema:url', publicValue],
      ['rezics:penNameOf', privateValue],
    ]) {
      const result = await f.call(owner, 'POST', `/v1/subjects/${subject}/candidates`, {
        statement: { property: { id: property }, value: { type: 'value', content } },
      });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      candidates.push(result.body.candidate);
    }
    expect(
      (
        await f.call(survivor, 'POST', `/v1/subjects/${subject}/candidates/${candidates[0]}:accept`, {
          context: GLOBAL_CONTEXT,
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call(survivor, 'POST', `/v1/subjects/${subject}:adopt`, {
          context: GLOBAL_CONTEXT,
          property: 'schema:url',
          mode: 'replace',
          selection: [{ candidate: candidates[0], rank: 'normal' }],
          expected_head: null,
        })
      ).status,
    ).toBe(200);
    const zones: string[] = [];
    for (const archived of [false, true]) {
      const input = createBody();
      input.configuration.scope = [];
      input.configuration.labels.en = `Owned private ${randomUUID()}`;
      const result = await f.call(owner, 'POST', '/v1/zones', input);
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      zones.push(result.body.zone.id);
      if (archived)
        expect(
          (
            await f.call(owner, 'DELETE', `/v1/zones/${result.body.zone.id}`, undefined, {
              'if-match': JSON.stringify(result.body.zone.revision),
            })
          ).status,
        ).toBe(200);
    }
    // Include a genuine former owner, so a current-owner-only Source cannot pass.
    const former = await f.call(owner, 'POST', '/v1/contexts', { labels: { en: 'Surviving former-owner Context' } });
    expect(former.status, JSON.stringify(former.body)).toBe(201);
    const formerId = former.body.context.id as string;
    const valid = (
      await f.db.admin.query(
        `SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
       AND grant_role='semantic.context.owner' AND upper_inf(valid)`,
        [routeOf(formerId), formerId, owner.accountId],
      )
    ).rows[0].valid;
    expect(
      (
        await f.call(owner, 'POST', '/v1/roleGrants', {
          resource: { route: routeOf(formerId), id: formerId },
          subject: { kind: 'account', id: survivor.accountId },
          role: 'semantic.context.owner',
          valid,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await f.call(owner, 'POST', '/v1/roleGrants:revoke', {
          resource: { route: routeOf(formerId), id: formerId },
          subject: { kind: 'account', id: owner.accountId },
          role: 'semantic.context.owner',
          valid,
        })
      ).status,
    ).toBe(200);
    const originals = await f.db.admin.query<{ partition_no: number; transaction_id: string }>(
      `SELECT DISTINCT r.route/16 AS partition_no,r.recorded_transaction_id AS transaction_id
       FROM semantic.candidate c JOIN semantic.revision r USING(route,subject_id,revision)
       WHERE c.route=$1 AND c.subject_id=$2 AND c.candidate_id=ANY($3::uuid[])
       UNION SELECT route/16,recorded_transaction_id FROM zones.zone WHERE zone_id=ANY($4::uuid[])`,
      [routeOf(subject), subject, candidates, zones],
    );
    expect(originals.rows.length).toBeGreaterThanOrEqual(4);
    const before = await inventories(f, owner.accountId);
    expect(before.sourceKeys.size).toBeGreaterThan(0);
    const deletion = await f.tombstone(owner);
    const barrier = (
      await f.db.admin.query<HistoryBarrier>(
        `SELECT account_id::text AS "accountId",route AS "accountRoute",version,at::text
       FROM access.erasure WHERE route=$1 AND account_id=$2`,
        [routeOf(owner.accountId), owner.accountId],
      )
    ).rows[0]!;
    expect(Date.parse(barrier.at)).toBe(Date.parse(deletion.result.at));
    worker = await accountErasureWorker(f.db.url);
    const deadline = Date.now() + 180_000;
    while ((await readSemanticErasure(f.db.pool, owner.accountId))?.state !== 'pending-shared-custody') {
      if (Date.now() >= deadline)
        throw new Error('Native Semantic/Zone local minimization did not reach its custody boundary');
      await Bun.sleep(20);
    }
    // Leave actual DBOS/enqueue/receiving copies in place. An external process is never
    // allowed to perform unmetered work during the shared harness's measured operations.
    await worker.stop();
    worker = undefined;
    let native = await inventories(f, owner.accountId);
    for (const key of before.sourceKeys)
      expect(native.sourceKeys.has(key), `Lost historical native Source role ${key}`).toBe(true);
    for (const key of native.sourceKeys) expect(Buffer.byteLength(key)).toBeLessThanOrEqual(1024);
    expect([...native.sourceKeys].some((key) => key.includes(':context:') && key.includes(':owner:'))).toBe(true);
    expect([...native.sourceKeys].some((key) => key.includes(':zone:'))).toBe(true);

    // The independent Source-owned cursor must transfer every home and historical role.
    // Advancing it is real work: count every command, failed point, byte and background query.
    let proof: Awaited<ReturnType<typeof readSubjectErasureSourceProof>> = null;
    let previousPage: string | undefined;
    for (let page = 0; page <= 4096 + native.sourceKeys.size; page++) {
      const sampled = await capture(f.db, () => readSubjectErasureSourceProof({ pool: f.db.pool }, barrier, context()));
      allWork(costOf(sampled.capture));
      proof = sampled.value;
      if (proof) break;
      const cursor = (
        await f.db.admin.query<{ id: string; source_partition: number; store: string; role: string }>(
          `SELECT id,source_partition,store,role FROM semantic.erasure_source_terminal
           WHERE route=$1 AND account_id=$2 AND version=$3 AND at=$4::timestamptz`,
          [barrier.accountRoute, barrier.accountId, barrier.version, barrier.at],
        )
      ).rows[0];
      expect(
        cursor?.id,
        `Native Source custody pending: ${JSON.stringify(cursor ?? { accountId: owner.accountId })}`,
      ).toBeDefined();
      expect(cursor?.id, `Native Source custody did not advance: ${JSON.stringify(cursor)}`).not.toBe(previousPage);
      previousPage = cursor?.id;
    }
    expect(proof, 'Sealed all-role/all-home Source proof unavailable; local EOF is insufficient').not.toBeNull();

    // Match actual original producer transactions to installed History locators. A preference
    // artifact, an empty history prefix or a hand-built locator cannot stand in for these copies.
    const custodyTransactions = new Set<string>();
    for (const home of native.homes) {
      const copies = await f.db.admin.query<{ transaction_id: string; outbox_position: string | null }>(
        `SELECT DISTINCT transaction_id,outbox_position::text FROM semantic.erasure_shared_custody
         WHERE partition_no=$1 AND account_id=$2`,
        [home, owner.accountId],
      );
      for (const copy of copies.rows) {
        custodyTransactions.add(`${home}:${copy.transaction_id}`);
        const receipts = await f.db.admin.query(
          `SELECT principal_kind,principal_id,command_kind,idempotency_key FROM core.receipt
           WHERE partition_no=$1 AND transaction_id=$2`,
          [home, copy.transaction_id],
        );
        for (const row of receipts.rows) {
          expect(
            native.artifacts.some(({ partition, locator }) => {
              if (partition !== home || locator.artifactType !== 'command-receipt/v1') return false;
              return (
                locator.principalKind === row.principal_kind &&
                locator.principalId === row.principal_id &&
                commandHistoryKind(locator.commandKindId) === row.command_kind &&
                `rk1.${locator.keyVersion}.${Buffer.from(locator.keyToken, 'hex').toString('base64url')}` ===
                  row.idempotency_key
              );
            }),
            `Missing native receipt producer coverage: ${home}:${copy.transaction_id}:${row.command_kind}`,
          ).toBe(true);
        }
        if (copy.outbox_position) {
          const events = await f.db.admin.query<{ event_seq: number }>(
            'SELECT event_seq FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq',
            [home, copy.outbox_position],
          );
          for (const event of events.rows)
            expect(
              native.artifacts.some(
                ({ partition, locator }) =>
                  partition === home &&
                  locator.artifactType === 'outbox-event/v1' &&
                  locator.position === BigInt(copy.outbox_position!) &&
                  locator.eventSeq === event.event_seq,
              ),
              `Missing native outbox producer coverage: ${home}:${copy.outbox_position}:${event.event_seq}`,
            ).toBe(true);
        }
      }
    }
    for (const original of originals.rows)
      expect(
        custodyTransactions.has(`${original.partition_no}:${original.transaction_id}`),
        `Missing original producer custody: ${original.partition_no}:${original.transaction_id}`,
      ).toBe(true);
    for (const type of ['command-receipt/v1', 'outbox-event/v1', 'durable-work/v1']) {
      expect(
        native.artifacts.some((a) => a.locator.artifactType === type),
        `Missing original Semantic/Zone native ${type} inventory`,
      ).toBe(true);
    }
    // Let the supplied native minimizers finish receiving work before cost sampling. Waiting
    // ends on the independent owner/receiving ports, never local EOF, an ACK or global status.
    worker = await accountErasureWorker(f.db.url);
    const receivingDeadline = Date.now() + 180_000;
    for (;;) {
      const semantic = await readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'semantic', context());
      const zones = await readHistoryOwnerCoverage({ pool: f.db.pool }, barrier, 'zones', context());
      const gaps = [
        ...(semantic.state === 'pending' ? semantic.gaps : []),
        ...(zones.state === 'pending' ? zones.gaps : []),
      ];
      for (const original of native.artifacts)
        if (!(await readHistoryReceivingReceipt({ pool: f.db.pool }, barrier, original, context()))) {
          gaps.push(
            `${original.partition}:${Buffer.from(encodeLocator(original.locator)).toString('hex')}:receiving-custody`,
          );
        }
      if (gaps.length === 0) break;
      if (Date.now() >= receivingDeadline)
        throw new Error(`Native shared receiving remains pending: ${gaps.join(', ')}`);
      await Bun.sleep(20);
    }
    await worker.stop();
    worker = undefined;
    const closed = await inventories(f, owner.accountId);
    expect(closed.sourceKeys).toEqual(native.sourceKeys);
    const closedCopies = new Set(
      closed.artifacts.map((a) => `${a.partition}:${Buffer.from(encodeLocator(a.locator)).toString('hex')}`),
    );
    for (const original of native.artifacts)
      expect(
        closedCopies.has(`${original.partition}:${Buffer.from(encodeLocator(original.locator)).toString('hex')}`),
        'An original copied-history locator must survive receiving minimization',
      ).toBe(true);
    // Include copies produced while the native minimizers drained, rather than counting only
    // the earlier producer snapshot or treating a worker's completion as physical absence.
    native = closed;
    const artifact = native.artifacts[0]!;
    const populations = [...native.homes].map((home) => {
      const base = unrelatedSemanticPopulation(`shared-erasure-${home}`, home).population;
      return {
        ...base,
        rows(placement: Parameters<NonNullable<typeof base.rows>>[0]) {
          const rows = base.rows!(placement);
          const transaction = rows['semantic.revision']![0]!.recorded_transaction_id;
          const position = 1_000_000 + placement.ordinal;
          const token = placement.ordinal.toString(16).padStart(64, '0');
          const locator = encodeLocator({
            artifactType: 'command-receipt/v1',
            partitionNo: home,
            principalKind: 'account',
            principalId: survivor.accountId,
            commandKindId: 1,
            keyVersion: 0,
            keyToken: token,
          });
          // Unrelated pending fixture rows only. No receiving proof, seal, coverage or terminal
          // certificate is seeded. Every tested artifact above came from the real target producers.
          return {
            'editorial.write_basis': [
              {
                partition_no: home,
                transaction_id: transaction,
                epoch: 1,
                position,
                principal_kind: 'account',
                principal_id: survivor.accountId,
                client_id: 'unrelated-growth',
              },
            ],
            'semantic.erasure_source_role': [
              { partition_no: home, transaction_id: transaction, account_id: survivor.accountId, role: 'operator' },
            ],
            ...rows,
            'semantic.outbound_link': rows['semantic.outbound_link']!.map((row) => ({
              ...row,
              erasure_roles: [{ account_id: survivor.accountId, role: 'author' }],
            })),
            'semantic.inbound_link': rows['semantic.inbound_link']!.map((row) => ({
              ...row,
              erasure_roles: [{ account_id: survivor.accountId, role: 'author' }],
            })),
            'semantic.erasure_shared_custody': [
              {
                partition_no: home,
                account_id: survivor.accountId,
                role: 'operator',
                transaction_id: transaction,
                outbox_position: position,
              },
            ],
            'core.receipt': [
              {
                partition_no: home,
                principal_kind: 'account',
                principal_id: survivor.accountId,
                command_kind: 'access.account.preferences',
                idempotency_key: `rk1.0.${Buffer.from(token, 'hex').toString('base64url')}`,
                request_digest: Buffer.alloc(32),
                epoch: 1,
                position,
                transaction_id: transaction,
                response: { unrelated: true },
              },
            ],
            'core.history_locator': [
              {
                partition_no: home,
                account_route: routeOf(survivor.accountId),
                account_id: survivor.accountId,
                artifact_type: 'command-receipt/v1',
                locator: Buffer.from(locator),
                roles: 32,
                minimizer_version: 1,
              },
            ],
          };
        },
      };
    });
    const report = await checkGrowth(f.db, {
      name: 'Original native Semantic and Zone Source and shared receiving custody',
      scales: [64, 512, 4096],
      repetitions: 1,
      warmups: 1,
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      counted: {
        read: (value) => value as { receivingArtifacts: number },
        bounds: { receivingArtifacts: 'constant' },
        limits: { receivingArtifacts: 1 },
      },
      async grow(_db, scale, previous) {
        for (const population of populations) await seed(f.db, population, { from: previous, to: scale });
      },
      // One fixed, nonempty original artifact, with actual Source, both owner coverage proofs,
      // receiving closure and native final-home verification. Warm-ups replay the same real page.
      operation: () => verifyPage(f, barrier, artifact),
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    const allSamples = report.samples.map((sample) => ({ ...sample, cost: allWork(sample.repetitions[0]!) }));
    // Apply the same shared bounds to foreground AND background totals, including buffers;
    // neither DBOS traffic nor native command framing receives a separate allowance.
    expect(growthViolations(allSamples, { statements: 'constant', rows: 'constant', blocks: 'logarithmic' })).toEqual(
      [],
    );
    expect(growthByteViolations(allSamples, { requestBytes: 'constant', responseBytes: 'constant' })).toEqual([]);
    assertGrowthAccessPaths(report.name, report.samples, [
      'semantic.erasure_source_record',
      'semantic.erasure_source_terminal',
      'semantic.erasure_source_commit',
      'semantic.erasure_locator',
      'semantic.erasure_copy_role',
      'semantic.erasure_shared_custody',
      'core.receipt',
      'core.history_locator',
      'core.history_receiving_proof',
      'core.history_family_coverage',
    ]);
    // Enumerate every retained original copy, not just the measured representative. Port proofs
    // inspect native physical/receiving custody; no unavailable artifact is a passing case.
    let retainedCopies = 0;
    for (const original of native.artifacts) {
      expect(encodeLocator(original.locator).byteLength).toBeLessThanOrEqual(1024);
      const sampled = await capture(f.db, () => verifyPage(f, barrier, original));
      allWork(costOf(sampled.capture));
      retainedCopies += sampled.value.receivingArtifacts;
    }
    expect(retainedCopies).toBe(native.artifacts.length);
    const privateRow = await f.db.admin.query(
      'SELECT statement,erasure_private FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
      [routeOf(subject), subject, candidates[1]],
    );
    expect(privateRow.rows).toEqual([{ statement: {}, erasure_private: true }]);
    for (const zone of zones)
      expect(
        (
          await f.db.admin.query(
            'SELECT configuration,mounts,owner_id,state,restore_until FROM zones.zone WHERE route=$1 AND zone_id=$2',
            [routeOf(zone), zone],
          )
        ).rows,
      ).toEqual([{ configuration: null, mounts: [], owner_id: null, state: 'purged', restore_until: null }]);
    const retained = await f.call(undefined, 'GET', `/v1/subjects/${subject}`);
    expect(retained.status, JSON.stringify(retained.body)).toBe(200);
    expect(JSON.stringify(retained.body)).toContain(publicValue);
    expect(JSON.stringify(retained.body)).not.toContain(privateValue);
    expect(JSON.stringify(retained.body)).not.toContain(owner.handle);
    expect(
      (
        await f.db.admin.query('SELECT labels FROM semantic.context WHERE route=$1 AND context_id=$2', [
          routeOf(formerId),
          formerId,
        ])
      ).rows,
    ).toEqual([{ labels: { en: 'Surviving former-owner Context' } }]);
  } finally {
    try {
      await worker?.crash();
    } finally {
      await f.close();
    }
  }
}, 600_000);
