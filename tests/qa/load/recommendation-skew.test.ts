import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../../../services/main/src/modules/recommendation/derived-generation.ts';
import { RANKING_PROFILE, RankingGenerations } from '../../../services/main/src/modules/recommendation/ranking.ts';
import { meteredPool, retainBatch, slotOf } from '../integration/recommendation-support.ts';

test('REC02: hot target and sparse ranking keep bounded batch and page costs', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_RELAY_DATABASE_URL) {
    throw new Error('Run through the isolated load tier');
  }
  const access = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL, max: 4 });
  const relay = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL, max: 2 });
  try {
    const meter = meteredPool(access);
    const principal = { issuer: 'https://load.rezics.test', subject: randomUUID() };
    const principalId = randomUUID();
    const actor = `https://rezics.com/id/${randomUUID()}`;
    await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)',
      [principalId, principal.issuer, principal.subject]);
    await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')", [actor]);
    await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [MANAGE_SCOPE]);
    await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, actor, MANAGE_ACTION]);
    await access.query(`INSERT INTO access.permission_grant
      (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`,
    [randomUUID(), actor, MANAGE_SCOPE, MANAGE_ACTION]);

    const works = Array.from({ length: 1_000 }, () => `https://rezics.com/id/${randomUUID()}`);
    const hot = works[0]!;
    const dataEpoch = randomUUID();
    const realm = `https://rezics.com/id/${randomUUID()}`;
    const width = 100;
    const batches = 200;
    for (let batch = 0; batch < batches; batch++) {
      const signals = Array.from({ length: width }, (_, offset) => {
        const index = batch * width + offset;
        return { work: batch < batches / 2 ? hot : works[1 + (index % (works.length - 1))]!,
          realm, slot: slotOf(`rec-load-${index}`),
          observation: `https://rezics.com/id/${randomUUID()}`, value: 10 };
      });
      await retainBatch(relay, dataEpoch, batch + 1, signals);
    }
    const rankings = new RankingGenerations({ access: meter.pool, relay, dataEpoch,
      cursorKey: randomBytes(32), canReadWork: async () => true });
    const basis = { profile: RANKING_PROFILE, population: { kind: 'public' as const },
      candidateGrain: 'work' as const, semantic: null };
    const context = { principal, actingSubject: actor };
    const build = await rankings.registerBuild(context, basis, 32,
      { idempotencyKey: `rec-load-${randomUUID()}`, requestDigest: 'a'.repeat(64) });
    const lease = await rankings.claim(build.generation);
    let applied = 0;
    let maxStatements = 0;
    for (;;) {
      meter.reset();
      const batch = await rankings.runBatch(build.generation, lease);
      maxStatements = Math.max(maxStatements, meter.count());
      expect(batch.failed).toBeUndefined();
      expect(batch.relayBatches).toBeLessThanOrEqual(16);
      expect(batch.signals).toBeLessThanOrEqual(1600);
      applied += batch.relayBatches;
      if (batch.relayBatches === 0) break;
    }
    expect(applied).toBe(batches);
    expect(maxStatements).toBeLessThanOrEqual(32);
    expect((await rankings.finish(build.generation, lease)).state).toBe('ready');
    expect((await rankings.activate(context, build.generation, null,
      { idempotencyKey: `rec-activate-${randomUUID()}`, requestDigest: 'b'.repeat(64) })).outcome).toBe('succeeded');
    const totals = (await access.query<{ scores: string; slots: string }>(`SELECT
      (SELECT count(*)::text FROM access.ranking_score WHERE generation_id = $1) AS scores,
      (SELECT count(*)::text FROM access.ranking_signal_slot WHERE generation_id = $1) AS slots`,
    [build.generation])).rows[0]!;
    expect(totals).toEqual({ scores: '1000', slots: '20000' });
    meter.reset();
    const page = await rankings.page({ principal, actingSubject: actor }, basis, 20);
    expect(page.items[0]?.candidate).toBe(hot);
    expect(page.items).toHaveLength(20);
    expect(meter.count()).toBeLessThanOrEqual(16);
    await access.query('ANALYZE access.ranking_score');
    const plan = (await access.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT candidate
      FROM access.ranking_score WHERE generation_id = $1 ORDER BY score DESC, candidate LIMIT 41`,
    [build.generation])).rows.map(row => row['QUERY PLAN']).join('\n');
    expect(plan).toContain('ranking_score_order');
  } finally { await Promise.all([access.end(), relay.end()]); }
}, 170_000);
