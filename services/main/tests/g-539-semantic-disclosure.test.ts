import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { exportRoutes } from '../src/routes/exports.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

test('G-539: summaries cannot bind an unrelated Work and semantic disclosure has one Access owner', () => {
  const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const summary = source('modules/media/summary.ts');
  expect(summary).toContain('IF(${workType} && BOUND(?work), EXISTS');
  expect(summary).not.toContain('row.public = false');
  expect(summary).not.toContain('rv:semanticWork');
  expect(summary).toContain('row.public = publicSemantics.has(reference)');
  const batch = source('modules/media/access-batch.ts');
  expect(batch).toContain('return readSemanticDisclosure');
  expect(batch).not.toContain("resources, 'semantic:read:', 'semantic.read'");
  expect(batch).not.toContain('rv:semanticHead');
  expect(source('modules/access/admission.ts')).toContain('await publicSemantics(');
  expect(source('routes/resources.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
  expect(source('routes/media.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
  expect(source('routes/search.ts')).toContain('canReadSemantics(null, null, resources, fuseki)');
});

test('G-539: an exact semantic export cannot substitute ordinary Work read authority for a history grant', async () => {
  const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    if (!query.includes('ASK')) throw new Error('denied export read historical bytes');
    return { boolean: true };
  };
  let checkedRevision: string | undefined;
  let workReads = 0;
  let cancelled = false;
  const app = exportRoutes({ environment: { fuseki: graph, objectDirectory: '.temp/g-539-export',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
  account: { verify: async () => ({ issuer: 'https://account.test', subject: 'reader' }) },
  access: {
    register: async () => ({ id: 'admission', principalId: 'principal', state: 'claimed', dispatchEligible: true }),
    recordGraphOutcome: async () => {},
    canReadWork: async () => { workReads++; return true; },
    canReadSemanticResource: async (_principal: unknown, _actor: unknown, _resource: string,
      exactRevision?: string) => { checkedRevision = exactRevision; return false; },
  }, exports: { readByAdmission: async () => null, cancel: async () => { cancelled = true; return {}; } },
  } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.test/v1/exports', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'old-semantic-export' },
    body: JSON.stringify({ profile: 'export-create-v1', actingSubject: resource, useScope: 'excerpt',
      selection: { kind: 'semantic-revision', reference: revision, resource,
        expectedPosition: { dataEpoch: 'epoch', sequence: '1' } } }) }));
  expect(response.status).toBe(404);
  expect(checkedRevision).toBe(revision);
  expect(workReads).toBe(0);
  expect(cancelled).toBe(true);
});
