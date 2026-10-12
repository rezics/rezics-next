import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
import { releaseFixturePreservationHold } from '../src/modules/access/fixture-preservation.ts';
import { restrictFixtureDisclosure } from '../src/modules/access/fixture-disclosure.ts';
import { discloseContent } from '../src/modules/disclosure/assembly.ts';
import type { DisclosureChannel } from '../src/modules/disclosure/read.ts';
import { disclosureViewer } from '../src/modules/disclosure/viewer.ts';
import { withDeliveryCut } from '../src/modules/rights/delivery-cut.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial,
  RightsInvalid, RightsStore, RightsUnavailable, type AssessmentInput } from '../src/modules/rights/store.ts';
import { suppressGraphContentRevisions } from '../src/modules/erasure/graph.ts';
import { GRAPHS, iri } from '../src/modules/work/activate.ts';
import { problem } from '../src/routes/problems.ts';
import { meterPool } from '../../../tests/qa/integration/support/query-cost-meter.ts';

let stack: MediaStack;
beforeAll(async () => { stack = await startMediaStack('rights-delivery-cut'); }, 120_000);
afterAll(async () => { await stack?.stop(); }, 60_000);

type Statement = { query: unknown; parameters: unknown };
function record<T extends Pool | PoolClient>(source: T, statements: Statement[]): T {
  return new Proxy(source, {
    get(target, property) {
      if (property === 'query') return (...args: unknown[]) => {
        statements.push({ query: args[0], parameters: args[1] });
        return Reflect.apply(target.query, target, args);
      };
      if (property === 'connect' && 'connect' in target) {
        return async () => record(await (target as Pool).connect(), statements);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function fixture(identity: { provider: string | null; namespace: string | null } = {
  provider: null, namespace: null,
}, privateTarget = false, originalContribution = false) {
  const member = await stack.member(`delivery-${randomUUID()}`);
  const work = privateTarget ? await stack.privateWork(member.actor, 'Private delivery target')
    : await stack.publicWork(member.actor, ['en'], 'Delivery target');
  await member.grant(`work:read:${work.work}`, 'work.read');
  const authority = await fixtureAuthorityScenario(stack.accessPool,
    { scope: ASSESS_SCOPE, action: ASSESS_ACTION, mandate: ASSESS_ACTION });
  const rights = stack.composition.dependencies.rights!.store;
  const input: AssessmentInput = { actingSubject: authority.actor,
    material: { ...publicDomainWorkMaterial(work.work), ...identity }, ...PUBLIC_DOMAIN_TEXT_USE,
    expressionKind: 'expression', basis: 'public_domain', outcome: 'supported',
    licenseInstrument: null, exceptionKind: null, rationale: 'Public-domain delivery fixture',
    extent: {}, evidence: {}, obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() };
  let head = await rights.assess(authority.principal, input);
  const text = `Exact Content bytes ${randomUUID()}`;
  await member.grant(`content:draft:${work.work}`, 'content.draft');
  const draft = await member.send('POST', '/v1/content-drafts', {
    ...(originalContribution ? { profile: 'content-text-v1' }
      : { profile: 'content-public-domain-text-v1', assessmentId: head.assessmentId,
        source: { provider: 'gutenberg', identifier: '1',
          url: 'https://www.gutenberg.org/ebooks/1', byteDigest: 'a'.repeat(64),
          retrievedAt: '2026-10-12T00:00:00.000Z' } }),
    resourceId: work.work,
    variantId: `urn:rezics:variant:${randomUUID()}`,
    language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
    expectedHead: null, body: text, actingSubject: member.actor,
  });
  if (draft.status !== 201) throw new Error(`Delivery fixture draft failed: ${await draft.text()}`);
  const { revisionId } = await draft.json() as { revisionId: string };
  const exact = (await stack.content.readExactBatch([revisionId], async ids => new Set(ids)))[0];
  if (exact?.status !== 'available') throw new Error('Delivery fixture draft bytes are unavailable');
  const serializedJson = exact.serializedJson;
  const target = { resourceId: work.work, assessmentId: head.assessmentId, rights };
  const deliveredTarget = { ...target, assessmentId: exact.reference.provenance.kind === 'admitted-public-domain-v1'
    && typeof exact.reference.provenance.rightsAssessmentId === 'string'
    ? exact.reference.provenance.rightsAssessmentId : null };
  const moveRights = async (outcome: 'supported' | 'not_supported' = 'supported') => {
    head = await rights.assess(authority.principal, { ...input, outcome,
      expectedAssessment: head.assessmentId, idempotencyKey: randomUUID() });
  };
  const hold = async (resource = work.work) => {
    const privateReport = privateTarget && resource === work.work;
    const receipt = await stack.composition.dependencies.publicReports!.submit({
      profile: 'public-report-v1', category: 'child_exploitation', target: resource,
      statement: 'Preserve reported material', contentLanguage: 'en',
      ...(privateReport ? { actingSubject: member.actor } : {}),
    }, randomUUID(), new Request('http://main.local', { headers: privateReport
      ? { authorization: `Bearer ${member.token}` } : {} }), privateReport ? member.principal : null);
    return receipt;
  };
  let attempts = 0;
  // The existing route supplies the real Content, Rights and disclosure checks.
  // The final publication read is deliberately after them, as in the Zone route.
  // Re-run graph erasure after that query; it does not move the Rights head.
  const deliver = async (duringQuery: (attempt: number) => Promise<void> = async () => {},
    channel: DisclosureChannel = 'read') => {
    const query = stack.fuseki.query.bind(stack.fuseki);
    const interceptor = spyOn(stack.fuseki, 'query').mockImplementation(async (sparql, maxBytes) => {
      const result = await query(sparql, maxBytes);
      if (sparql.includes('# final-publication-delivery')) await duringQuery(attempts);
      return result;
    });
    try {
      const cut = await withDeliveryCut(deliveredTarget,
        () => stack.access.canReadWork(member.principal, member.actor, work.work), async () => {
        attempts++;
        const response = await member.send('GET',
          `/v1/content-revisions/${revisionId}?actingSubject=${encodeURIComponent(member.actor)}`);
        if (response.status !== 200) return response;
        const initial = (await discloseContent(stack.env, [exact],
          disclosureViewer(member.principal, member.actor), channel))[0];
        if (initial?.status !== 'available') return problem(404, 'revision_unavailable', 'Revision is unavailable');
        const published = await stack.fuseki.query(`# final-publication-delivery
          ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(work.work)} a <https://schema.org/CreativeWork> } }`);
        if (published.boolean !== true) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        return response;
      }, async response => {
        if (response.status !== 200) return response;
        // A new owner statement after the publication query; never reuse its
        // earlier disclosure decision or a transaction's older snapshot.
        await stack.access.assertRecoveryOpen();
        const final = (await discloseContent(stack.env, [exact],
          disclosureViewer(member.principal, member.actor), channel))[0];
        await stack.access.assertRecoveryOpen();
        return final?.status === 'available' ? response
          : problem(404, 'revision_unavailable', 'Revision is unavailable');
      });
      return cut.status === 'stable' ? cut.value : cut.status === 'denied'
        ? problem(404, 'revision_unavailable', 'Revision is unavailable') : problem(503, 'delivery_cut_unavailable', 'Delivery is unavailable; retry', { 'retry-after': '1' });
    } finally { interceptor.mockRestore(); }
  };
  return { target, deliveredTarget, text, serializedJson, revisionId, hold, moveRights, deliver, input, authority, member,
    attempts: () => attempts };
}

async function withheld(response: Response, text: string) {
  expect(response.status).not.toBe(200);
  const body = await response.text();
  expect(body).not.toContain('serializedJson');
  expect(body).not.toContain(text);
}

test('stable owner tokens deliver exact Content through production composition', async () => {
  const f = await fixture();
  const response = await f.deliver();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ serializedJson: f.serializedJson });
  expect(f.attempts()).toBe(1);
});

test('authorization precedes holds and owner failures; hidden and nonexistent targets have identical 404 bytes', async () => {
  const f = await fixture({ provider: null, namespace: null }, true);
  const outsider = await stack.member(`outsider-${randomUUID()}`);
  await outsider.grant('work:read', 'work.read');
  let reads = 0, deliveries = 0;
  const rights = { deliveryCutSnapshot: async (resourceId: string, assessmentId: string | null) => {
    reads++;
    return f.target.rights.deliveryCutSnapshot(resourceId, assessmentId);
  } };
  const deliver = async (resourceId: string) => {
    const cut = await withDeliveryCut({ ...f.target, resourceId, rights },
      () => stack.access.canReadWork(outsider.principal, outsider.actor, resourceId),
      async () => { deliveries++; return Response.json({ serializedJson: f.text }); }, async value => value);
    return cut.status === 'stable' ? cut.value : cut.status === 'denied'
      ? problem(404, 'comment_unavailable', 'Comment is unavailable')
      : problem(503, 'delivery_cut_unavailable', 'Delivery is unavailable; retry', { 'retry-after': '1' });
  };
  const missing = await deliver(`https://rezics.com/id/${randomUUID()}`);
  const privateResponse = await deliver(f.target.resourceId);
  await f.hold();
  const held = await deliver(f.target.resourceId);
  expect(missing.status).toBe(404);
  expect(privateResponse.status).toBe(404);
  expect(held.status).toBe(404);
  expect(await privateResponse.text()).toBe(await held.clone().text());
  expect(await held.text()).toBe(await missing.text());
  expect(reads).toBe(0);
  expect(deliveries).toBe(0);
  const authorized = await withDeliveryCut(f.target,
    () => stack.access.canReadWork(f.member.principal, f.member.actor, f.target.resourceId),
    async () => { deliveries++; return f.text; }, async value => value);
  expect(authorized).toEqual({ status: 'unavailable-retry' });
  expect(deliveries).toBe(0);
  expect(await withDeliveryCut({ ...f.target, rights: undefined }, async () => false, async () => f.text, async value => value))
    .toEqual({ status: 'denied' });
});

test('a replay authorizes again before consulting the target owners or returning bytes', async () => {
  const f = await fixture();
  let authorizations = 0, reads = 0, deliveries = 0;
  const target = { ...f.target, rights: { deliveryCutSnapshot: async (resourceId: string, assessmentId: string | null) => {
    reads++;
    return f.target.rights.deliveryCutSnapshot(resourceId, assessmentId);
  } } };
  expect(await withDeliveryCut(target, async () => ++authorizations === 1, async () => {
    deliveries++;
    await f.moveRights();
    return f.text;
  }, async value => value)).toEqual({ status: 'denied' });
  expect(authorizations).toBe(2);
  expect(reads).toBe(2);
  expect(deliveries).toBe(1);
});

test('a not_supported assessment committed during the final query discards the bytes', async () => {
  const f = await fixture();
  await withheld(await f.deliver(async () => { await f.moveRights('not_supported'); }), f.text);
  expect(f.attempts()).toBe(2);
});

test.each([
  { provider: null, namespace: null },
  { provider: 'gutenberg', namespace: null },
  { provider: null, namespace: 'ebooks' },
])('the delivered assessment identity governs every admitted Work/body shape: %j', async identity => {
  const f = await fixture(identity);
  expect(await f.target.rights.currentPublicDomainAssessment(f.target.resourceId, f.target.assessmentId)).toBe(true);
  expect(await f.target.rights.currentPublicDomainAssessment(f.target.resourceId, f.target.assessmentId.toUpperCase())).toBe(true);
  expect(await f.target.rights.currentPublicDomainAssessments([
    { work: f.target.resourceId, assessmentId: f.target.assessmentId },
  ])).toContain(`${f.target.resourceId}\0${f.target.assessmentId}`);
  expect((await f.deliver()).status).toBe(200);
  await withheld(await f.deliver(async () => { await f.moveRights('not_supported'); }), f.text);
  expect(f.attempts()).toBe(3);
});

test('the no-assessment token stays constant when a first Work/body assessment appears', async () => {
  const member = await stack.member(`unassessed-${randomUUID()}`);
  const work = await stack.publicWork(member.actor, ['en'], 'Unassessed delivery');
  const f = await fixture();
  const target = { ...f.target, resourceId: work.work, assessmentId: null };
  const before = await target.rights.deliveryCutSnapshot(target.resourceId, null);
  expect(before.assessmentHead).toBe('no-assessment');
  let attempts = 0;
  const result = await withDeliveryCut(target, async () => true, async () => {
    if (++attempts === 1) await target.rights.assess(f.authority.principal, { ...f.input,
      material: { ...publicDomainWorkMaterial(work.work), provider: 'gutenberg' },
      expectedAssessment: null, idempotencyKey: randomUUID() });
    return attempts;
  }, async value => value);
  expect(result).toEqual({ status: 'stable', value: 1 });
  expect((await target.rights.deliveryCutSnapshot(target.resourceId, null)).assessmentHead).toBe('no-assessment');
});

test('original contribution delivers despite another Gutenberg assessment moving during every query', async () => {
  const f = await fixture({ provider: 'gutenberg', namespace: null }, false, true);
  expect(f.deliveredTarget.assessmentId).toBeNull();
  // The old fallback replayed both queries and then withheld the contribution.
  for (let delivery = 0; delivery < 2; delivery++) {
    const response = await f.deliver(async () => { await f.moveRights('not_supported'); });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ serializedJson: f.serializedJson });
    expect(f.attempts()).toBe(delivery + 1);
  }
});

test('a null assessment reference still refuses movement of its own preservation hold', async () => {
  const f = await fixture({ provider: 'gutenberg', namespace: null }, false, true);
  const response = await f.deliver(async () => { await f.hold(); });
  expect(response.status).toBe(503);
  await withheld(response, f.text);
  expect(f.attempts()).toBe(1);
});

test('the cut follows the exact material rather than another head on the same Work', async () => {
  const f = await fixture({ provider: 'gutenberg', namespace: null });
  await f.target.rights.assess(f.authority.principal, { ...f.input,
    material: publicDomainWorkMaterial(f.target.resourceId), idempotencyKey: randomUUID() });
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  expect(before.assessmentHead).toBe(f.target.assessmentId);
  await f.moveRights('not_supported');
  expect((await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).assessmentHead)
    .not.toBe(before.assessmentHead);
  expect(await f.target.rights.currentPublicDomainAssessment(f.target.resourceId, f.target.assessmentId)).toBe(false);
});

test('provider/namespace service scopes and other Work components are not body assessments', async () => {
  const f = await fixture();
  const service = await f.target.rights.assess(f.authority.principal, { ...f.input,
    material: { ...publicDomainWorkMaterial(f.target.resourceId), scopeKind: 'source_provider',
      workId: null, provider: 'gutenberg', namespace: 'ebooks' },
    expressionKind: 'service', family: 'service_terms', basis: 'service_terms', useScope: 'fixture:service',
    idempotencyKey: randomUUID() });
  const title = await f.target.rights.assess(f.authority.principal, { ...f.input,
    material: { ...publicDomainWorkMaterial(f.target.resourceId), component: 'title' },
    idempotencyKey: randomUUID() });
  for (const assessment of [service, title]) {
    expect(await f.target.rights.currentPublicDomainAssessment(f.target.resourceId, assessment.assessmentId)).toBe(false);
    expect((await f.target.rights.deliveryCutSnapshot(f.target.resourceId, assessment.assessmentId)).assessmentHead)
      .toBeNull();
  }
  await expect(f.target.rights.assess(f.authority.principal, { ...f.input,
    material: { ...publicDomainWorkMaterial(f.target.resourceId), provider: 'gutenberg', namespace: 'ebooks' },
    idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(RightsInvalid);
});

test('a preservation hold committed during the final query discards the bytes', async () => {
  const f = await fixture();
  const response = await f.deliver(async () => { await f.hold(); });
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  await withheld(response, f.text);
  expect(f.attempts()).toBe(1);
});

test('graph erasure during the final query is caught by the existing erasure check inside the cut', async () => {
  const f = await fixture();
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  await withheld(await f.deliver(async () => {
    await suppressGraphContentRevisions(stack.fuseki, stack.env.lineage,
      randomUUID(), '1', [f.revisionId]);
  }), f.text);
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).toEqual(before);
  expect(f.attempts()).toBe(1);
});

test.each(['disclosure', 'search'] as const)('a fresh final fence catches %s committed during publication with stable cut tokens', async effect => {
  const f = await fixture();
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  const restrict = () => restrictFixtureDisclosure(stack.accessPool, {
    resourceId: f.target.resourceId, revisionId: f.revisionId, effect,
    principalId: f.member.principalId, actingSubject: f.member.actor,
  });
  await withheld(await f.deliver(restrict, effect === 'search' ? 'search' : 'read'), f.text);
  expect(f.attempts()).toBe(1);
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).toEqual(before);
});

test('every replay runs its final fence after the query and before returning the fresh value', async () => {
  const f = await fixture();
  const order: string[] = [];
  let attempts = 0;
  const result = await withDeliveryCut(f.target, async () => { order.push('authorize'); return true; }, async () => {
    order.push('query');
    if (++attempts === 1) await f.moveRights();
    return attempts;
  }, async value => { order.push('fence'); return value; });
  expect(result).toEqual({ status: 'stable', value: 2 });
  expect(order).toEqual(['authorize', 'query', 'fence', 'authorize', 'query', 'fence']);
});

test('an unrelated hold committed during the query neither replays nor refuses delivery', async () => {
  const f = await fixture();
  const other = await stack.publicWork((await stack.member('unrelated')).actor, ['en'], 'Unrelated target');
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  const response = await f.deliver(async () => { await f.hold(other.work); });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ serializedJson: f.serializedJson });
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).toEqual(before);
  expect(f.attempts()).toBe(1);
});

test('a hold added and released during the query still advances its own token and replays', async () => {
  const f = await fixture();
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  const response = await f.deliver(async attempt => {
    if (attempt !== 1) return;
    const receipt = await f.hold();
    await releaseFixturePreservationHold(stack.accessPool, f.target.resourceId, receipt.caseId);
  });
  expect(response.status).toBe(200);
  expect(f.attempts()).toBe(2);
  const after = await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId);
  expect(after.held).toBe(false);
  expect(BigInt(after.preservationVersion)).toBeGreaterThan(BigInt(before.preservationVersion));
});

test('concurrent intake for one case counts its hold once and release restores delivery', async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([f.hold(), f.hold()]);
  expect(second.caseId).toBe(first.caseId);
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).toMatchObject({
    preservationVersion: '1', held: true,
  });
  await releaseFixturePreservationHold(stack.accessPool, f.target.resourceId, first.caseId);
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId, f.target.assessmentId)).toMatchObject({
    preservationVersion: '2', held: false,
  });
  expect((await f.deliver()).status).toBe(200);
});

test('movement on both attempts returns a typed retry outcome without retaining either value', async () => {
  const f = await fixture();
  let attempts = 0;
  const result = await withDeliveryCut(f.target, async () => true, async () => {
    attempts++;
    await f.moveRights();
    return { serializedJson: f.text };
  }, async value => value);
  expect(attempts).toBe(2);
  expect(result).toEqual({ status: 'unavailable-retry' });
  expect(JSON.stringify(result)).not.toContain(f.text);
});

test('a single head movement replays the full callback and returns only the fresh value', async () => {
  const f = await fixture();
  let attempts = 0;
  const result = await withDeliveryCut(f.target, async () => true, async () => {
    attempts++;
    if (attempts === 1) await f.moveRights();
    return attempts;
  }, async value => value);
  expect(result).toEqual({ status: 'stable', value: 2 });
  expect(attempts).toBe(2);
});

test('all snapshot statements cost one indexed read per store, independent of movement and 1,000 unrelated holds', async () => {
  const f = await fixture();
  const content: Statement[] = [], access: Statement[] = [];
  // Only the snapshot store uses these proxies. Movement commands and plan
  // inspection use the original stores, so their work cannot pollute the cut.
  // meterPool counts every pool AND checked-out client statement, with no SQL filter.
  const contentMeter = meterPool(record(stack.contentPool, content)), accessMeter = meterPool(record(stack.accessPool, access));
  const measured = new RightsStore(contentMeter, accessMeter);
  const plans: { query: unknown; parameters: unknown; pool: typeof stack.contentPool }[] = [];
  let snapshots = 0;
  const target = { ...f.target, rights: { deliveryCutSnapshot: async (resourceId: string, assessmentId: string | null) => {
    content.length = 0; access.length = 0;
    const before = [contentMeter.queries, accessMeter.queries];
    const value = await measured.deliveryCutSnapshot(resourceId, assessmentId);
    expect(contentMeter.queries - before[0]!).toBe(1);
    expect(accessMeter.queries - before[1]!).toBe(1);
    // Capture every issued statement as well, so the index assertion covers
    // the implementation's SQL, never a hand-written copy of the desired query.
    expect(content).toHaveLength(1);
    expect(access).toHaveLength(1);
    if (snapshots++ === 0) {
      for (const { query, parameters } of content) plans.push({ query, parameters, pool: stack.contentPool });
      for (const { query, parameters } of access) plans.push({ query, parameters, pool: stack.accessPool });
    }
    return value;
  } } };
  for (const history of [0, 1000]) {
    if (history) {
      const before = await stack.accessPool.query<{ n: string }>('SELECT count(*)::text AS n FROM access.governance_preservation_hold');
      // Intake requires actual readable targets. Create through the graph owner,
      // then hold them after graph movement stops so intake has a stable cut.
      const unrelated: string[] = [];
      for (let ordinal = 0; ordinal < history; ordinal++) {
        unrelated.push((await stack.catalogueWork(f.member.actor, `Unrelated preserved metadata ${ordinal}`)).work);
      }
      for (let batch = 0; batch < 50; batch++) {
        await Promise.all(unrelated.slice(batch * 20, (batch + 1) * 20).map(resource => f.hold(resource)));
      }
      const after = await stack.accessPool.query<{ n: string }>('SELECT count(*)::text AS n FROM access.governance_preservation_hold');
      expect(BigInt(after.rows[0]!.n) - BigInt(before.rows[0]!.n)).toBe(1000n);
    }
    for (const moving of [false, true]) {
      contentMeter.reset(); accessMeter.reset(); snapshots = 0;
      const cut = await withDeliveryCut(target, async () => true,
        async () => { if (moving) await f.moveRights(); return f.text; }, async value => value);
      expect(cut).toEqual(moving ? { status: 'unavailable-retry' } : { status: 'stable', value: f.text });
      expect(snapshots).toBe(moving ? 4 : 2);
      expect(contentMeter.queries).toBe(moving ? 4 : 2);
      expect(accessMeter.queries).toBe(moving ? 4 : 2);
      expect(contentMeter.queries + accessMeter.queries).toBe(moving ? 8 : 4);
    }
  }
  for (const { query, parameters, pool } of plans) {
    if (typeof query !== 'string' || !Array.isArray(parameters)) throw new Error('Expected a recorded SQL statement');
    expect(query).not.toMatch(/\b(COUNT|SUM|ORDER BY)\b/i);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(`EXPLAIN ${query}`, parameters);
      const text = plan.rows.map(row => row['QUERY PLAN']).join('\n');
      expect(text).toMatch(/Index (Only )?Scan/);
      expect(text).not.toMatch(/Seq Scan|governance_preservation_hold/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
}, 420_000);

test('snapshot rows examined stay constant for null and exact references beside 1, 50 and 500 quotation materials', async () => {
  const f = await fixture();
  const content: Statement[] = [], access: Statement[] = [];
  const measured = new RightsStore(record(stack.contentPool, content), record(stack.accessPool, access));
  type Plan = { 'Node Type': string; 'Actual Rows': number; 'Actual Loops': number;
    'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number;
    'Rows Removed by Index Recheck'?: number; Plans?: Plan[] };
  const examined = (node: Plan): number => {
    expect(node['Node Type']).not.toMatch(/Seq Scan|Bitmap/);
    return (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)
      + (node['Rows Removed by Join Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0))
      * node['Actual Loops'] + (node.Plans ?? []).reduce((sum, child) => sum + examined(child), 0);
  };
  const cost = async (pool: Pool, statements: Statement[]) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      let rows = 0;
      for (const { query, parameters } of statements) {
        if (typeof query !== 'string' || !Array.isArray(parameters)) throw new Error('Expected recorded snapshot SQL');
        const result = await client.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, parameters);
        rows += examined(result.rows[0]!['QUERY PLAN'][0]!.Plan);
      }
      return rows;
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  let materials = 0, quotationReference: string | null = null;
  const baseline = new Map<string | null, { content: number; access: number }>();
  for (const size of [1, 50, 500]) {
    for (; materials < size; materials++) {
      const quotation = await f.target.rights.assess(f.authority.principal, { ...f.input,
        material: { ...publicDomainWorkMaterial(f.target.resourceId), provider: `quotation-${materials}` },
        useKind: 'quotation', expectedAssessment: null, idempotencyKey: randomUUID() });
      quotationReference ??= quotation.assessmentId;
    }
    for (const assessmentId of [null, f.target.assessmentId, quotationReference]) {
      content.length = 0; access.length = 0;
      const snapshot = await measured.deliveryCutSnapshot(f.target.resourceId, assessmentId);
      expect(snapshot.assessmentHead).toBe(assessmentId === null ? 'no-assessment'
        : assessmentId === f.target.assessmentId ? f.target.assessmentId : null);
      expect(content).toHaveLength(assessmentId === null ? 0 : 1);
      expect(access).toHaveLength(1);
      const rows = { content: await cost(stack.contentPool, content), access: await cost(stack.accessPool, access) };
      // Count all plan nodes, including rejected candidates, rather than LIMIT's output.
      expect(rows.content).toBeLessThanOrEqual(12);
      expect(rows.access).toBeLessThanOrEqual(1);
      if (size === 1) baseline.set(assessmentId, rows);
      expect(rows).toEqual(baseline.get(assessmentId)!);
    }
  }
}, 120_000);

test('held and missing owners fail closed before the callback; owner failures after work discard bytes', async () => {
  const f = await fixture();
  let attempts = 0;
  const work = async () => { attempts++; return f.text; };
  expect(await withDeliveryCut({ resourceId: f.target.resourceId, assessmentId: f.target.assessmentId }, async () => true, work, async value => value))
    .toEqual({ status: 'unavailable-retry' });
  await f.hold();
  expect(await withDeliveryCut(f.target, async () => true, work, async value => value)).toEqual({ status: 'unavailable-retry' });
  expect(attempts).toBe(0);
  let reads = 0;
  const failure = { ...f.target, rights: { deliveryCutSnapshot: async () => {
    if (++reads === 2) throw new RightsUnavailable('owner read failed');
    return { assessmentHead: null, preservationVersion: '0', held: false };
  } } };
  expect(await withDeliveryCut(failure, async () => true, work, async value => value)).toEqual({ status: 'unavailable-retry' });
  expect(attempts).toBe(1);
  await expect(withDeliveryCut({ ...f.target, resourceId: 'invalid' }, async () => true, work, async value => value))
    .rejects.toBeInstanceOf(RightsInvalid);
});
