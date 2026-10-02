import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { reportRoutes } from '../src/routes/reports.ts';

const agent = () => `https://rezics.com/id/${randomUUID()}`;

test('rights complaint restriction outcomes reach the governance owner through the HTTP contract', async () => {
  const received: string[] = [];
  const caseId = randomUUID();
  let status: 'completed' | 'accepted' | 'partial' = 'completed';
  const app = reportRoutes({ account: { verify: async () => ({}) }, governance: {
    store: { decide: async (_principal: unknown, input: { outcome: string }) => {
      received.push(input.outcome);
      const decisionId = randomUUID();
      return { decisionId, caseId, caseGeneration: '1',
        outcome: input.outcome, replayed: false, enforcement: [],
        operation: { operationId: decisionId, status, items: [], continuation: null } };
    } },
  } } as never);
  for (const outcome of ['interim_restrict', 'final_restrict']) {
    for (const state of ['completed', 'accepted', 'partial'] as const) {
      status = state;
      const key = randomUUID();
      const response = await app.handle(new Request('http://main.test/v1/moderation/decisions', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ profile: 'moderation-decision-v1', outcome, caseId,
          expectedGeneration: '0', actingSubject: agent(), targets: [{ owner: 'graph',
            resource: agent(), component: 'title', locator: null, scopeKind: 'exact_revision',
            revision: 'revision-1', expectedHead: 'revision-1', effect: 'disclosure' }],
          rule: { ref: 'urn:policy:rights', revision: '1', digest: 'a'.repeat(64) },
          evidenceDigest: 'b'.repeat(64), reversesDecisionId: null, answersStepId: null,
          rationale: null, disclosure: 'parties', idempotencyKey: key }),
      }));
      expect(response.status).toBe(state === 'completed' ? 200 : 202);
      expect(await response.json()).toMatchObject({ outcome, operation: { status: state } });
    }
  }
  expect(received).toEqual(['interim_restrict', 'interim_restrict', 'interim_restrict',
    'final_restrict', 'final_restrict', 'final_restrict']);
});
