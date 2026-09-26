import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessJudgments, JudgmentUnavailable }
  from '../../../services/main/src/modules/judgment/access.ts';
import { ratingAccount } from '../support/rating-account.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

type Write = { receipt: string; revision: string; replayed: boolean };
type Summary = { generation: string; fit: { sampleSize: number;
  distribution: { negative: number; positive: number } }; spoiler: { sampleSize: number;
  protection: string; status: string; confidence: string;
  distribution: { notSpoiler: number; minorSpoiler: number; majorSpoiler: number } };
  viewer: { fit: number | null; fitRevision: string; spoiler: number | null;
    spoilerRevision: string } | null };

test('GOV09/GOV10: Account, Jena Statement and Access judgment write/read preserve independent dimensions', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const f = await contextFixture(Bun.env as Record<string, string>);
  const voterAccount = await ratingAccount(Bun.env as Record<string, string>,
    'openid judgment:write judgment:read');
  try {
    const voterA = randomUUID(), voterB = randomUUID();
    await f.accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1,$2,$3),($4,$2,$5)`, [voterA, voterAccount.issuer, voterAccount.a.id,
      voterB, voterAccount.b.id]);
    const realm = await f.realm('Judgment scope');
    await f.globalAcceptance();
    const work = await f.work('Judgment target');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const statementBody = { profile: 'statement-v1', speaker: { kind: 'personal' },
      subject: work.mainVersion, predicate: `${RV}classifiedAs`,
      relationDefinition: nativeId(), value: { kind: 'resource', iri: nativeId() },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA };
    const recorded = await f.json<{ statement: string }>(
      await f.call('POST', '/v1/statements', statementBody), 201);
    const statement = recorded.statement;
    const path = `/v1/statements/${statement.split('/').at(-1)}/judgments`;
    const store = new AccessJudgments(f.accessPool);
    let loseResponse = true;
    class LostResponseJudgments extends AccessJudgments {
      override async write(...args: Parameters<AccessJudgments['write']>) {
        const result = await super.write(...args);
        if (loseResponse) { loseResponse = false; throw new JudgmentUnavailable('lost Access response'); }
        return result;
      }
    }
    const app = createMainApp(f.env.fuseki, { environment: f.env,
      account: voterAccount.verifier, access: f.access, judgments: new LostResponseJudgments(f.accessPool) });
    const call = (method: string, token: string, body?: object, key = randomUUID(), suffix = '') =>
      app.handle(new Request(`http://main.local${path}${suffix}`, { method,
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': key,
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, status: number): Promise<T> => {
      const body = await response.json();
      if (response.status !== status) console.error('judgment response', response.status, body);
      expect(response.status).toBe(status);
      return body as T;
    };
    const fit = { profile: 'statement-judgment-v1', context: { kind: 'global' },
      dimension: 'fit', value: 1, expectedRevision: '0' };
    // A readable Statement alone does not permit a judgment before admission.
    expect((await call('POST', voterAccount.tokenA, fit)).status).toBe(403);
    await f.grant('classification:decide:global', 'statement.decide');
    await f.json(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement },
      acceptance: { kind: 'global' }, expectedDecisionHead: null,
      outcome: 'accepted', actingSubject: f.actorA }), 201);
    expect((await call('POST', voterAccount.noScope, fit)).status).toBe(401);
    const initial = await json<Summary>(await call('GET', voterAccount.tokenA), 200);
    expect(initial).toMatchObject({ generation: '0', viewer: null,
      fit: { sampleSize: 0 }, spoiler: { sampleSize: 0, status: 'unknown',
        protection: 'hide-any' } });

    const lostKey = randomUUID();
    expect((await call('POST', voterAccount.tokenA, fit, lostKey)).status).toBe(503);
    const replay = await json<Write>(await call('POST', voterAccount.tokenA, fit, lostKey), 200);
    expect(replay).toMatchObject({ revision: '1', replayed: true });
    const changedIntent = await call('POST', voterAccount.tokenA,
      { ...fit, value: -1 }, lostKey);
    expect(changedIntent.status).toBe(409);
    const spoiler = { ...fit, dimension: 'spoiler', value: 2 };
    const fitNext = { ...fit, value: -1, expectedRevision: '1' };
    const raced = await Promise.all([call('POST', voterAccount.tokenA, spoiler),
      call('POST', voterAccount.tokenA, fitNext)]);
    expect(raced.map(response => response.status).sort()).toEqual([201, 201]);
    const stale = await call('POST', voterAccount.tokenA,
      { ...spoiler, value: 0, expectedRevision: '0' });
    expect(stale.status).toBe(409);
    const summary = await json<Summary>(await call('GET', voterAccount.tokenA), 200);
    expect(summary).toMatchObject({ generation: '3',
      fit: { sampleSize: 1, distribution: { negative: 1, positive: 0 } },
      spoiler: { sampleSize: 1, status: 'major', protection: 'hide-major', confidence: 'low',
        distribution: { notSpoiler: 0, minorSpoiler: 0, majorSpoiler: 1 } },
      viewer: { fit: -1, fitRevision: '2', spoiler: 2, spoilerRevision: '1' } });
    // An unrelated principal changes the distribution, never voter A's head.
    const otherKey = randomUUID();
    const sameKeyRace = await Promise.all([call('POST', voterAccount.tokenB,
      { ...spoiler, value: 0 }, otherKey), call('POST', voterAccount.tokenB,
      { ...spoiler, value: 0 }, otherKey)]);
    expect(sameKeyRace.map(response => response.status).sort()).toEqual([200, 201]);
    const other = await json<Write>(sameKeyRace.find(response => response.status === 201)!, 201);
    expect(other.revision).toBe('1');
    const mixed = await json<Summary>(await call('GET', voterAccount.tokenA), 200);
    expect(mixed.spoiler).toMatchObject({ sampleSize: 2, status: 'disputed',
      distribution: { notSpoiler: 1, minorSpoiler: 0, majorSpoiler: 1 } });
    await f.grant(`classification:decide:${realm.realm}`, 'statement.decide');
    await f.json(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement },
      acceptance: { kind: 'realm', realm: realm.realm }, expectedDecisionHead: null,
      outcome: 'accepted', actingSubject: f.actorA }), 201);
    await f.accessPool.query(`INSERT INTO access.authority_subject (id, kind)
      VALUES ($1, 'agent') ON CONFLICT DO NOTHING`, [realm.realm]);
    await f.accessPool.query(`INSERT INTO access.membership_policy
      (kind, owner_subject, revision, terms_revision)
      VALUES ('realm', $1, 1, 'judgment-test-terms')`, [realm.realm]);
    const consent = randomUUID();
    await f.accessPool.query(`INSERT INTO access.private_membership_consent
      (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
        terms_revision, next_generation, expires_at)
      VALUES ($1,$2,0,'realm',$3,1,'judgment-test-terms',1,now() + interval '5 minutes')`,
    [consent, voterA, realm.realm]);
    await f.accessPool.query(`INSERT INTO access.private_membership
      (id, kind, owner_subject, principal_id, state, generation, policy_revision,
        terms_revision, consent_reference)
      VALUES ($1,'realm',$2,$3,'joined',1,1,'judgment-test-terms',$4)`,
    [randomUUID(), realm.realm, voterA, consent]);
    const realmBody = { ...spoiler, context: { kind: 'realm', realm: realm.realm } };
    expect((await call('POST', voterAccount.tokenB, realmBody)).status).toBe(403);
    await json<Write>(await call('POST', voterAccount.tokenA, realmBody), 201);
    const realmSummary = await json<Summary>(await call('GET', voterAccount.tokenA,
      undefined, randomUUID(), `?realm=${encodeURIComponent(realm.realm)}`), 200);
    expect(realmSummary).toMatchObject({ generation: '1', fit: { sampleSize: 0 },
      spoiler: { sampleSize: 1, distribution: { majorSpoiler: 1 } } });
    expect((await call('GET', voterAccount.tokenB,
      undefined, randomUUID(), `?realm=${encodeURIComponent(realm.realm)}`)).status).toBe(403);
    const history = await f.accessPool.query(`SELECT dimension, revision, value FROM access.judgment_revision
      WHERE principal_id = $1 AND statement = $2 AND context_key = 'global'
      ORDER BY created_at, dimension`, [voterA, statement]);
    expect(history.rows).toHaveLength(3);
    expect(history.rows.map(row => row.dimension).sort()).toEqual(['fit', 'fit', 'spoiler']);
    const mutation = await f.accessPool.query(`UPDATE access.judgment_revision SET value = 0
      WHERE principal_id = $1 AND statement = $2 AND context_key = 'global'`,
    [voterA, statement]).then(() => null, error => error as { code?: string });
    expect(mutation?.code).toBe('23514');
    expect((await f.accessPool.query(`SELECT COUNT(*)::int AS count FROM access.judgment_receipt
      WHERE principal_id = $1`, [voterA])).rows[0]?.count).toBe(4);
    const planClient = await f.accessPool.connect();
    try {
      await planClient.query('BEGIN');
      await planClient.query('SET LOCAL enable_seqscan = off');
      const plan = await planClient.query(`EXPLAIN SELECT * FROM access.judgment_aggregate
        WHERE statement = $1 AND context_key = 'global'`, [statement]);
      expect(plan.rows.map(row => row['QUERY PLAN']).join(' ')).toContain('judgment_aggregate_pkey');
      await planClient.query('ROLLBACK');
    } finally { planClient.release(); }
    expect(await store.read({ issuer: voterAccount.issuer, subject: voterAccount.a.id },
      statement, { kind: 'global' })).toMatchObject({ generation: '4' });
    const cleared = await json<Write>(await call('POST', voterAccount.tokenA,
      { ...fit, value: null, expectedRevision: '2' }), 201);
    expect(cleared.revision).toBe('3');
    const afterClear = await json<Summary>(await call('GET', voterAccount.tokenA), 200);
    expect(afterClear).toMatchObject({ fit: { sampleSize: 0 },
      spoiler: { sampleSize: 2 }, viewer: { fit: null, fitRevision: '3', spoiler: 2,
        spoilerRevision: '1' } });
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id = true');
    try {
      expect((await call('GET', voterAccount.tokenA)).status).toBe(503);
      expect((await call('POST', voterAccount.tokenA, fit, lostKey)).status).toBe(503);
    } finally {
      await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id = true');
    }
  } finally { await voterAccount.close(); await f.close(); }
}, 120_000);
