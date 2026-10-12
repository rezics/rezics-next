import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { fixtureAuthorityScenario } from '../src/modules/access/fixture-authority-scenario.ts';
import { releaseFixturePreservationHold } from '../src/modules/access/fixture-preservation.ts';
import { withDeliveryCut } from '../src/modules/rights/delivery-cut.ts';
import { ASSESS_ACTION, ASSESS_SCOPE, PUBLIC_DOMAIN_TEXT_USE, publicDomainWorkMaterial,
  RightsInvalid, RightsUnavailable, type AssessmentInput } from '../src/modules/rights/store.ts';
import { graphErasedContentRevisions, suppressGraphContentRevisions } from '../src/modules/erasure/graph.ts';
import { GRAPHS, iri } from '../src/modules/work/activate.ts';
import { problem } from '../src/routes/problems.ts';

let stack: MediaStack;
beforeAll(async () => { stack = await startMediaStack('rights-delivery-cut'); }, 120_000);
afterAll(async () => { await stack?.stop(); }, 60_000);

async function fixture() {
  const member = await stack.member(`delivery-${randomUUID()}`);
  const work = await stack.publicWork(member.actor, ['en'], 'Delivery target');
  await member.grant(`work:read:${work.work}`, 'work.read');
  const authority = await fixtureAuthorityScenario(stack.accessPool,
    { scope: ASSESS_SCOPE, action: ASSESS_ACTION, mandate: ASSESS_ACTION });
  const rights = stack.composition.dependencies.rights!.store;
  const input: AssessmentInput = { actingSubject: authority.actor,
    material: publicDomainWorkMaterial(work.work), ...PUBLIC_DOMAIN_TEXT_USE,
    expressionKind: 'expression', basis: 'public_domain', outcome: 'supported',
    licenseInstrument: null, exceptionKind: null, rationale: 'Public-domain delivery fixture',
    extent: {}, evidence: {}, obligations: [], expectedAssessment: null, idempotencyKey: randomUUID() };
  let head = await rights.assess(authority.principal, input);
  const text = `Exact Content bytes ${randomUUID()}`;
  const saved = await stack.content.saveDraft({ operationId: randomUUID(),
    variant: { id: `urn:rezics:variant:${randomUUID()}`, resourceId: work.work,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr' },
    expectedHead: null, model: 'content-shape-v1', sourceRevision: null,
    provenance: { kind: 'admitted-public-domain-v1', rightsAssessmentId: head.assessmentId },
    serializedJson: JSON.stringify({ body: text }) });
  if (!saved.revisionId) throw new Error('Delivery fixture draft was not saved');
  const revisionId = saved.revisionId;
  const target = { resourceId: work.work, rights };
  const moveRights = async (outcome: 'supported' | 'not_supported' = 'supported') => {
    head = await rights.assess(authority.principal, { ...input, outcome,
      expectedAssessment: head.assessmentId, idempotencyKey: randomUUID() });
  };
  const hold = async (resource = work.work) => {
    const receipt = await stack.composition.dependencies.publicReports!.submit({
      profile: 'public-report-v1', category: 'child_exploitation', target: resource,
      statement: 'Preserve reported material', contentLanguage: 'en',
    }, randomUUID(), new Request('http://main.local'), null);
    return receipt;
  };
  let attempts = 0;
  // The existing route supplies the real Content, Rights and disclosure checks.
  // The final publication read is deliberately after them, as in the Zone route.
  // Re-run graph erasure after that query; it does not move the Rights head.
  const deliver = async (duringQuery: (attempt: number) => Promise<void> = async () => {}) => {
    const query = stack.fuseki.query.bind(stack.fuseki);
    const interceptor = spyOn(stack.fuseki, 'query').mockImplementation(async (sparql, maxBytes) => {
      const result = await query(sparql, maxBytes);
      if (sparql.includes('# final-publication-delivery')) await duringQuery(attempts);
      return result;
    });
    try {
      const cut = await withDeliveryCut(target, async () => {
        attempts++;
        const response = await member.send('GET',
          `/v1/content-revisions/${revisionId}?actingSubject=${encodeURIComponent(member.actor)}`);
        if (response.status !== 200) return response;
        const published = await stack.fuseki.query(`# final-publication-delivery
          ASK { GRAPH ${iri(GRAPHS.current)} {
          ${iri(work.work)} a <https://schema.org/CreativeWork> } }`);
        if (published.boolean !== true) return problem(404, 'revision_unavailable', 'Revision is unavailable');
        await stack.access.assertRecoveryOpen();
        const erased = await graphErasedContentRevisions(stack.fuseki, [revisionId]);
        await stack.access.assertRecoveryOpen();
        return erased.has(revisionId)
          ? problem(404, 'revision_unavailable', 'Revision is unavailable') : response;
      });
      return cut.status === 'stable' ? cut.value
        : problem(503, 'delivery_cut_unavailable', 'Delivery is unavailable; retry', { 'retry-after': '1' });
    } finally { interceptor.mockRestore(); }
  };
  return { target, text, revisionId, hold, moveRights, deliver, attempts: () => attempts };
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
  expect(await response.json()).toMatchObject({ serializedJson: JSON.stringify({ body: f.text }) });
  expect(f.attempts()).toBe(1);
});

test('a not_supported assessment committed during the final query discards the bytes', async () => {
  const f = await fixture();
  await withheld(await f.deliver(async () => { await f.moveRights('not_supported'); }), f.text);
  expect(f.attempts()).toBe(2);
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
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId);
  await withheld(await f.deliver(async () => {
    await suppressGraphContentRevisions(stack.fuseki, stack.env.lineage,
      randomUUID(), '1', [f.revisionId]);
  }), f.text);
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId)).toEqual(before);
  expect(f.attempts()).toBe(1);
});

test('an unrelated hold committed during the query neither replays nor refuses delivery', async () => {
  const f = await fixture();
  const other = await stack.publicWork((await stack.member('unrelated')).actor, ['en'], 'Unrelated target');
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId);
  const response = await f.deliver(async () => { await f.hold(other.work); });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ serializedJson: JSON.stringify({ body: f.text }) });
  expect(await f.target.rights.deliveryCutSnapshot(f.target.resourceId)).toEqual(before);
  expect(f.attempts()).toBe(1);
});

test('a hold added and released during the query still advances its own token and replays', async () => {
  const f = await fixture();
  const before = await f.target.rights.deliveryCutSnapshot(f.target.resourceId);
  const response = await f.deliver(async attempt => {
    if (attempt !== 1) return;
    const receipt = await f.hold();
    await releaseFixturePreservationHold(stack.accessPool, f.target.resourceId, receipt.caseId);
  });
  expect(response.status).toBe(200);
  expect(f.attempts()).toBe(2);
  const after = await f.target.rights.deliveryCutSnapshot(f.target.resourceId);
  expect(after.held).toBe(false);
  expect(BigInt(after.preservationVersion)).toBeGreaterThan(BigInt(before.preservationVersion));
});

test('movement on both attempts returns a typed retry outcome without retaining either value', async () => {
  const f = await fixture();
  let attempts = 0;
  const result = await withDeliveryCut(f.target, async () => {
    attempts++;
    await f.moveRights();
    return { serializedJson: f.text };
  });
  expect(attempts).toBe(2);
  expect(result).toEqual({ status: 'unavailable-retry' });
  expect(JSON.stringify(result)).not.toContain(f.text);
});

test('a single head movement replays the full callback and returns only the fresh value', async () => {
  const f = await fixture();
  let attempts = 0;
  const result = await withDeliveryCut(f.target, async () => {
    attempts++;
    if (attempts === 1) await f.moveRights();
    return attempts;
  });
  expect(result).toEqual({ status: 'stable', value: 2 });
  expect(attempts).toBe(2);
});

test('token reads cost one indexed statement per store per snapshot, with and without movement', async () => {
  const f = await fixture();
  const content = spyOn(stack.contentPool, 'query');
  const access = spyOn(stack.accessPool, 'query');
  try {
    for (const moving of [false, true]) {
      content.mockClear(); access.mockClear();
      await withDeliveryCut(f.target, async () => { if (moving) await f.moveRights(); return f.text; });
      const contentReads = content.mock.calls.filter(([query]) => typeof query === 'string'
        && query.includes('AS assessment_head'));
      const accessReads = access.mock.calls.filter(([query]) => typeof query === 'string'
        && query.includes('FROM access.governance_preservation_delivery_head'));
      expect(contentReads).toHaveLength(moving ? 4 : 2);
      expect(accessReads).toHaveLength(moving ? 4 : 2);
      for (const [query, actualParameters] of [...contentReads, ...accessReads]) {
        if (typeof query !== 'string') throw new Error('Expected a delivery-cut SQL statement');
        expect(query).not.toMatch(/\b(COUNT|SUM|ORDER BY)\b/i);
        const parameters = [f.target.resourceId];
        expect(actualParameters).toEqual(parameters);
        const client = await (query.includes('AS assessment_head') ? stack.contentPool : stack.accessPool).connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL enable_seqscan = off');
          const plan = await client.query(`EXPLAIN ${query}`, parameters);
          expect(plan.rows.map(row => row['QUERY PLAN']).join('\n')).toMatch(/Index (Only )?Scan/);
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
    }
  } finally { content.mockRestore(); access.mockRestore(); }
});

test('held and missing owners fail closed before the callback; owner failures after work discard bytes', async () => {
  const f = await fixture();
  let attempts = 0;
  const work = async () => { attempts++; return f.text; };
  expect(await withDeliveryCut({ resourceId: f.target.resourceId }, work))
    .toEqual({ status: 'unavailable-retry' });
  await f.hold();
  expect(await withDeliveryCut(f.target, work)).toEqual({ status: 'unavailable-retry' });
  expect(attempts).toBe(0);
  let reads = 0;
  const failure = { ...f.target, rights: { deliveryCutSnapshot: async () => {
    if (++reads === 2) throw new RightsUnavailable('owner read failed');
    return { assessmentHead: null, preservationVersion: '0', held: false };
  } } };
  expect(await withDeliveryCut(failure, work)).toEqual({ status: 'unavailable-retry' });
  expect(attempts).toBe(1);
  await expect(withDeliveryCut({ ...f.target, resourceId: 'invalid' }, work))
    .rejects.toBeInstanceOf(RightsInvalid);
});
