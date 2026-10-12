import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { discloseInventory } from '../src/modules/disclosure/read.ts';
import { unrecordedReasons } from '../src/modules/governance/notices.ts';
import type { DecisionInput } from '../src/modules/governance/store.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { GRAPHS, RV } from '../src/modules/work/activate.ts';

async function json<T>(response: Response, status = 201): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as T;
}

test('ordinary Concept, Agent and Space reports confirm disclosure receipts and fence direct and directory reads', async () => {
  const label = `Graph moderation ${randomUUID()}`;
  const stack = await startMediaStack('graph-owner-disclosure', { profileCredits: true });
  try {
    const editor = await stack.member(`${label} owner`), staff = await stack.member(`${label} staff`);
    await editor.grant('space:create:root', 'space.create');
    const space = await json<{ space: string }>(await editor.send('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: label, capabilities: ['realm'], actingSubject: editor.actor,
    }));
    await editor.grant('classification:define:global', 'classification.proposition.define');
    const concept = await json<{ concept: string }>(await editor.send('POST', '/v1/classification-vocabulary', {
      profile: 'classification-proposition-v2', scheme: null, labels: [{ language: 'en', value: label }],
      alternativeLabels: [], broader: [], narrower: [], actingSubject: editor.actor,
    }));
    await staff.grant('governance:platform', 'governance.moderate');
    await staff.grant('governance:platform', 'governance.rule.publish');
    const governance = stack.composition.dependencies.governance!;
    const rule = await governance.rules!.publish(staff.principal, {
      ref: `urn:rule:${randomUUID()}`, scopeId: 'governance:platform', actingSubject: staff.actor,
      expectedRevision: null, document: { purpose: 'Review graph disclosure' }, idempotencyKey: randomUUID(),
    });
    for (const [kind, resource] of [
      ['Concept', concept.concept],
      ['Agent', editor.actor],
      ['Space', space.space],
    ] as const) {
      const rows = (await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH <${GRAPHS.current}> { <${resource}> rv:head ?head }
      } LIMIT 2`, 4096)).results?.bindings ?? [];
      expect(rows).toHaveLength(1);
      const head = rows[0]!.head!.value;
      expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.current}> {
        { <${resource}> a <https://schema.org/CreativeWork> } UNION { <${resource}> rv:mainVersion ?main }
      } }`, 1024)).boolean).toBe(false);
      const path = `/v1/resources/${resource.slice(-36)}`;
      await json(await stack.call('GET', path), 200);
      const target = { owner: 'graph' as const, resource, component: 'record' as const, revision: head, locator: null };
      expect(await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'search')).toEqual(['visible']);
      const report = await json<{ reportId: string; caseId: string }>(await editor.send('POST', '/v1/public-reports', {
        profile: 'public-report-v1', target: resource, actingSubject: editor.actor,
        category: 'harassment', statement: `Review this ordinary ${kind}.`, contentLanguage: 'en',
      }));
      const basis = (await stack.accessPool.query<{ generation: string; evidence_digest: string }>(
        `SELECT c.generation::text,r.evidence_digest FROM access.governance_case c
         JOIN access.governance_report r ON r.case_id=c.id WHERE r.id=$1`, [report.reportId])).rows[0]!;
      await governance.store.safety.claim(staff.principal, staff.actor, report.caseId);
      const input: DecisionInput = {
        caseId: report.caseId, expectedGeneration: basis.generation, actingSubject: staff.actor, outcome: 'restrict',
        targets: [{ ...target, revision: null, scopeKind: 'component', expectedHead: head, effect: 'disclosure' }],
        rule, evidenceDigest: basis.evidence_digest, reversesDecisionId: null, answersStepId: null,
        rationale: null, disclosure: 'private', idempotencyKey: randomUUID(), reasons: {
          ...unrecordedReasons, facts: 'The retained record was reviewed.', scope: `This ${kind} record.`,
          duration: 'Until reconsidered.', automation: false,
        },
      };
      const result = await governance.store.decide(staff.principal, input);
      expect(result.operation.status).toBe('completed');
      const effects = (await stack.accessPool.query<{ state: string; receipt: string }>(
        'SELECT state,receipt FROM access.safety_decision_effect WHERE decision_id=$1', [result.decisionId])).rows;
      expect(effects).toHaveLength(1);
      expect(effects[0]!.state).toBe('confirmed');
      expect(effects[0]!.receipt).toStartWith('urn:rezics:receipt:moderation:');
      expect((await stack.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <${GRAPHS.receipts}> {
        <${effects[0]!.receipt}> rv:moderationTarget <${resource}> ; rv:expectedHead <${head}> ; rv:outcome rv:Succeeded
      } }`, 2048)).boolean).toBe(true);
      expect((await stack.accessPool.query('SELECT effect,state FROM access.governance_enforcement WHERE decision_id=$1',
        [result.decisionId])).rows).toEqual([{ effect: 'disclosure', state: 'restricted' }]);
      expect((await stack.call('GET', path)).status).toBe(404);
      expect(await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'read')).toEqual(['hidden']);
      expect(await discloseInventory(stack.env, [target], ANONYMOUS_VIEWER, 'search')).toEqual(['hidden']);
      if (kind === 'Concept') {
        const vocabulary = await json<{ items: { id: string }[] }>(await stack.call('GET',
          `/v1/classification-vocabulary?q=${encodeURIComponent(label)}`), 200);
        expect(vocabulary.items.some(item => item.id === resource)).toBe(false);
      }
    }
  } finally { await stack.stop(); }
}, 180_000);
