import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';
import { beginSemanticErasure, stepSemanticErasure } from '../../src/semantic/account-erasure.ts';

let f: AccountErasureFixture;
beforeAll(async () => {
  f = await accountErasureFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

test('native erasure step seeks the fixed account neighbourhood across unrelated 64/512/4096 population', async () => {
  const owner = await f.author();
  const unrelated = await f.author();
  const created = await f.call(unrelated, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Fixed owned neighbourhood' },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const subject = created.body.subject.id as string;
  for (let i = 0; i < 16; i++) {
    const proposal = await f.call(owner, 'POST', `/v1/subjects/${subject}/candidates`, {
      statement: {
        property: { id: 'schema:url' },
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } },
            ],
          },
        ],
        value: { type: 'value', content: `https://private.example.test/fixed/${i}` },
      },
    });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(201);
  }
  await f.tombstone(owner);
  await beginSemanticErasure(f.db.pool, owner.accountId);
  const { routeOf, partitionOf } = await import('../../src/route/route.ts');
  const target = partitionOf(routeOf(subject)!);
  for (;;) {
    const progress = (
      await f.db.admin.query('SELECT partition_no FROM semantic.erasure_progress WHERE route=$1 AND account_id=$2', [
        routeOf(owner.accountId),
        owner.accountId,
      ])
    ).rows[0];
    const next = await f.db.admin.query(
      `SELECT store FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND state='pending' ORDER BY priority,store,record_key,role LIMIT 1`,
      [target, owner.accountId],
    );
    if (progress.partition_no === target && next.rows[0]?.store === 'candidate') break;
    await stepSemanticErasure(f.db.pool, owner.accountId);
  }
  const report = await checkGrowth(f.db, {
    name: 'Semantic indexed account erasure local step',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      for (let i = previous; i < scale; i++) {
        const result = await f.call(unrelated, 'POST', '/v1/subjects', {
          type: 'schema:Person',
          labels: { en: `Unrelated communal ${i}` },
        });
        expect(result.status, JSON.stringify(result.body)).toBe(201);
      }
    },
    async operation() {
      const step = await stepSemanticErasure(f.db.pool, owner.accountId);
      expect(step.rawKeys).toBeLessThanOrEqual(100);
      expect(step.bytes).toBeLessThanOrEqual(65536);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 600_000);

test('native own-role and payload growth increases total pages while each minimization keeps its raw and byte caps', async () => {
  const unrelated = await f.author();
  const subject = await f.call(unrelated, 'POST', '/v1/subjects', {
    type: 'schema:Person',
    labels: { en: 'Surviving subject' },
  });
  expect(subject.status, JSON.stringify(subject.body)).toBe(201);
  const id = subject.body.subject.id as string;
  const { routeOf, partitionOf } = await import('../../src/route/route.ts');
  const { capture, costOf } = await import('../support/growth.ts');
  const ownCosts = [];
  const ownPages = [];
  // Separate native accounts keep immutable T and consumed checkpoints independent at each scale.
  for (const count of [8, 64, 512]) {
    const owner = await f.author();
    const candidates: string[] = [];
    for (let i = 0; i < count; i++) {
      const result = await f.call(owner, 'POST', `/v1/subjects/${id}/candidates`, {
        statement: {
          property: { id: 'schema:url' },
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/evidence' } },
              ],
            },
          ],
          value: { type: 'value', content: `https://private.example.test/${'x'.repeat(Math.min(count, 512))}/${i}` },
        },
      });
      expect(result.status, JSON.stringify(result.body)).toBe(201);
      candidates.push(result.body.candidate);
    }
    await f.tombstone(owner);
    await beginSemanticErasure(f.db.pool, owner.accountId);
    // Move through genuine empty native homes; no checkpoint or applicability is seeded.
    for (let home = 0; home < partitionOf(routeOf(id)!); home++) {
      let partition = home;
      while (partition === home) {
        await stepSemanticErasure(f.db.pool, owner.accountId);
        partition = (
          await f.db.admin.query('SELECT partition_no FROM semantic.erasure_progress WHERE account_id=$1', [
            owner.accountId,
          ])
        ).rows[0].partition_no;
      }
    }
    // The proposal's native expansion marker is a separate lower-priority physical locator.
    for (;;) {
      const next = await f.db.admin.query(
        `SELECT store FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND state='pending' ORDER BY priority,store,record_key,role LIMIT 1`,
        [partitionOf(routeOf(id)!), owner.accountId],
      );
      if (next.rows[0]?.store === 'candidate') break;
      await stepSemanticErasure(f.db.pool, owner.accountId);
    }
    // Consume every native candidate page, rather than extrapolating total work from the first key.
    let pages = 0;
    for (let index = 0; index < candidates.length; index++) {
      const sampled = await capture(f.db, () => stepSemanticErasure(f.db.pool, owner.accountId));
      expect(sampled.value.rawKeys).toBe(1);
      expect(sampled.value.bytes).toBeLessThanOrEqual(1024);
      const cost = costOf(sampled.capture);
      ownCosts.push(cost);
      expect(cost.statements).toBeLessThanOrEqual(100);
      expect(cost.rows, JSON.stringify(cost)).toBeLessThanOrEqual(100);
      expect(cost.responseBytes).toBeLessThanOrEqual(65536);
      pages++;
    }
    ownPages.push(pages);
    const physical = await f.db.admin.query(
      `SELECT c.candidate_id,l.store,l.state,c.statement,c.erasure_private FROM semantic.erasure_locator l
      JOIN semantic.candidate c ON c.erasure_key=l.record_key
      WHERE l.partition_no=$1 AND l.account_id=$2 AND l.store='candidate' AND c.candidate_id=ANY($3::uuid[])`,
      [partitionOf(routeOf(id)!), owner.accountId, candidates],
    );
    expect(new Set(physical.rows.map((row) => row.candidate_id))).toEqual(new Set(candidates));
    expect(
      physical.rows.every(
        (row) => row.state === 'minimized' && row.erasure_private && Object.keys(row.statement).length === 0,
      ),
    ).toBe(true);
  }
  expect(ownPages).toEqual([8, 64, 512]);
  // All measured SQL/pools, including native command framing and locator/progress writes, count.
  expect(Math.max(...ownCosts.map((cost) => cost.statements))).toBeLessThanOrEqual(100);
  expect(Math.max(...ownCosts.map((cost) => cost.rows)), JSON.stringify(ownCosts)).toBeLessThanOrEqual(100);
}, 600_000);
