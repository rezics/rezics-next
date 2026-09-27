import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { ManagementReadStore, realmGovernanceScope } from '../src/modules/management-reads/read-store.ts';
import { DATASET, GRAPHS, RV, iri } from '../src/modules/work/activate.ts';

const short = (id: string) => id.slice(-36);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; total: null; kind: string } }

test('Realm management: private report queue, decision audit, pagination, scope and stale fences', async () => {
  const stack = await startMediaStack('management-read');
  try {
    const a = await stack.member('moderator');
    const b = await stack.member('outsider');
    await a.grant('space:create:root', 'space.create');
    const made = await a.send('POST', '/v1/spaces', { profile: 'space-realm-v1', name: 'Management Realm',
      capabilities: ['realm'], actingSubject: a.actor });
    expect(made.status).toBe(201);
    const realm = (await made.json() as { realm: string }).realm;
    const scope = realmGovernanceScope(realm);
    await a.grant(scope, 'governance.moderate');
    const app = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      managementReads: new ManagementReadStore(stack.accessPool, stack.env),
      account: { verify: async request => {
        const token = request.headers.get('authorization')?.replace('Bearer ', '');
        if (token === a.token) return a.principal;
        if (token === b.token) return b.principal;
        throw new AccountAssertionDenied('missing bearer');
      } } });
    const get = (path: string, token?: string) => app.handle(new Request(`http://main.test${path}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} }));
    const root = `/v1/realms/${short(realm)}`;
    const moderation = (suffix = '', token = a.token, actor = a.actor) =>
      get(`${root}/moderation?actingSubject=${encodeURIComponent(actor)}${suffix}`, token);
    const audit = (suffix = '', token = a.token, actor = a.actor) =>
      get(`${root}/audit?actingSubject=${encodeURIComponent(actor)}${suffix}`, token);
    const cases = [];
    for (let n = 0; n < 3; n++) {
      const caseId = randomUUID();
      const target = `https://rezics.com/id/${randomUUID()}`;
      await stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
        authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
        VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
      [caseId, scope, realm, target]);
      await stack.accessPool.query(`INSERT INTO access.governance_report (id, case_id, principal_id,
        acting_subject, principal_epoch, idempotency_key, request_digest, reason_code,
        evidence_count, evidence_digest) VALUES ($1, $2, $3, $4, 0, $5, $6, 'incorrect', 1, $7)`,
      [randomUUID(), caseId, a.principalId, a.actor, `report-${n}`, digest(`request-${n}`), digest(`evidence-${n}`)]);
      cases.push({ caseId, target });
    }
    const otherRealm = `https://rezics.com/id/${randomUUID()}`;
    const otherScope = realmGovernanceScope(otherRealm);
    await stack.accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [otherScope]);
    await expect(stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
      authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
    [randomUUID(), scope, otherRealm, `https://rezics.com/id/${randomUUID()}`])).rejects.toMatchObject({ code: '23514' });
    expect((await get(`${root}/moderation?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(401);
    expect((await moderation('', b.token, b.actor)).status).toBe(404);
    expect((await get(`/v1/realms/${randomUUID()}/moderation?actingSubject=${encodeURIComponent(a.actor)}`,
      a.token)).status).toBe(404);
    const first = await moderation('&limit=1');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const page = await first.json() as Page<{ id: string; target: { resource: string };
      authorAgent: string; reasonCode: string }>;
    expect(page.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(page.nextCursor).toBeString();
    expect(cases.some(item => item.caseId === page.items[0]?.id)).toBe(true);
    expect(page.items[0]).toMatchObject({ authorAgent: a.actor, reasonCode: 'incorrect' });
    await stack.accessPool.query(`INSERT INTO access.governance_case (id, kind, authority_kind,
      authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
      VALUES ($1, 'content_report', 'realm', $2, $3, 'graph', $4, 'title', 'private')`,
    [randomUUID(), otherScope, otherRealm, `https://rezics.com/id/${randomUUID()}`]);
    expect((await moderation('&type=rights_complaint').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await moderation('&type=content_report').then(r => r.json()) as Page<unknown>).items)
      .toHaveLength(3);
    const second = await moderation(`&limit=1&cursor=${page.nextCursor}`);
    expect(second.status).toBe(200);
    const next = await second.json() as Page<{ id: string }>;
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    expect((await moderation(`&state=closed&cursor=${page.nextCursor}`)).status).toBe(400);
    expect((await moderation('&cursor=broken')).status).toBe(400);
    expect((await moderation('&limit=21')).status).toBe(400);
    const decisionId = randomUUID();
    await stack.accessPool.query(`INSERT INTO access.moderation_decision (id, kind, outcome,
      context, case_id, case_sequence, principal_id, acting_subject, authority_kind,
      authority_scope_id, authority_epoch, authority_proof_digest, idempotency_key,
      request_digest, rule_ref, rule_revision, rule_digest, evidence_digest, disclosure)
      VALUES ($1, 'content_moderation', 'dismiss', $2, $3, 1, $4, $5, 'realm', $6, 0,
        $7, 'decision-1', $8, 'urn:rezics:rule:test', 'r1', $9, $10, 'private')`,
    [decisionId, realm, cases[0]!.caseId, a.principalId, a.actor, scope,
      digest('proof'), digest('decision'), digest('rule'), digest('evidence')]);
    await stack.accessPool.query(`UPDATE access.governance_case SET decision_head = $2,
      generation = 1 WHERE id = $1`, [cases[0]!.caseId, decisionId]);
    const log = await audit();
    expect(log.status).toBe(200);
    expect((await log.json() as Page<{ id: string; actingSubject: string }>).items)
      .toMatchObject([{ id: decisionId, actingSubject: a.actor }]);
    expect((await audit('&kind=rights_disposition').then(r => r.json()) as Page<unknown>).items).toEqual([]);
    expect((await moderation(`&limit=1&cursor=${page.nextCursor}`)).status).toBe(409);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} <${RV}restoreHold> true . } }`);
    expect((await moderation()).status).toBe(503);
    await stack.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} <${RV}restoreHold> true . } }`);
    expect((await moderation()).status).toBe(200);
    await stack.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a <${RV}Realm> . } }`);
    expect((await moderation()).status).toBe(404);
    await stack.fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} a <${RV}Realm> . } }`);
    const query = stack.fuseki.query.bind(stack.fuseki);
    let resumeRead!: () => void;
    let readReached!: () => void;
    const paused = new Promise<void>(resolve => { readReached = resolve; });
    const resumed = new Promise<void>(resolve => { resumeRead = resolve; });
    let basisCalls = 0;
    stack.fuseki.query = async (...args) => {
      if (args[0].includes('SELECT ?epoch ?sequence ?realm') && ++basisCalls === 2) {
        readReached();
        await resumed;
      }
      return query(...args);
    };
    const inFlight = moderation();
    await paused;
    const revoke = stack.accessPool.query(`UPDATE access.permission_grant SET active = false
      WHERE scope_id = $1 AND recipient_subject = $2`, [scope, a.actor]);
    resumeRead();
    expect((await inFlight).status).toBe(200);
    await revoke;
    stack.fuseki.query = query;
    expect((await moderation()).status).toBe(404);
    expect((await audit()).status).toBe(404);
  } finally { await stack.stop(); }
});
