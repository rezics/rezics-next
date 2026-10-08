import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fusekiReadBudget, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_PROFILE } from '../src/modules/contribution/draft.ts';
import { DATASET, prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { contributionRoutes } from '../src/routes/contributions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000015';
const body = 'Best the day after baking.';
const id = (iri: string) => iri.slice('https://rezics.com/id/'.length);

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = join(import.meta.dir, '../../../.temp/contribution-draft-route', randomUUID());
  mkdirSync(directory, { recursive: true });
  try { return await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('draft GET spends the exact-draft budget on the current Work, the anchor and the identity', async () => {
  await withDirectory(async directory => {
    const manifestDigest = prepareComponent(directory, contribution, {
      work, author, language: 'en', body, publication: 'draft',
    }, CONTRIBUTION_PROFILE);
    const seen: { sparql: string; budgeted: boolean }[] = [];
    const fuseki = { query: async (sparql: string) => {
      seen.push({ sparql, budgeted: fusekiReadBudget.getStore() !== undefined });
      if (sparql.includes('RevisionAnchor')) return { results: { bindings: [{
        component: { type: 'uri', value: contribution },
        manifest: { type: 'uri', value: `urn:rezics:sha256:${manifestDigest}` },
        model: { type: 'uri', value: CONTRIBUTION_PROFILE },
        shape: { type: 'uri', value: CONTRIBUTION_PROFILE },
        dataset: { type: 'uri', value: DATASET },
        epoch: { type: 'literal', value: 'epoch-1' },
        sequence: { type: 'literal', value: '4' },
      }] } };
      if (sparql.includes('ASK')) return { boolean: true };
      throw new Error(`unexpected draft query: ${sparql.slice(0, 160)}`);
    } };
    const environment = { fuseki, objectDirectory: directory,
      lineage: { dataEpoch: 'epoch-1', routingEpoch: '1' } } as unknown as WorkActivationEnvironment;
    const accessQuery = 'PREFIX rv: <https://rezics.com/vocab/> ASK { BASELINE contribution read }';
    const app = contributionRoutes(fuseki as unknown as FusekiClient, {
      environment, account: { verify: async () => ({ issuer: 'test', subject: 'member' }) },
      access: { canReadContributionDraft: async () => {
        await fuseki.query(accessQuery);
        return true;
      } },
    } as unknown as MainWorkDependencies);
    const response = await app.handle(new Request(
      `http://main.local/v1/contributions/${id(contribution)}/drafts/${id(revision)}?actingSubject=${encodeURIComponent(author)}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contribution, revision, body });
    const budgeted = seen.filter(query => query.budgeted).map(query => query.sparql);
    expect(budgeted).toHaveLength(3);
    expect(budgeted[0]).toContain('schema:CreativeWork');
    expect(budgeted[1]).toContain('RevisionAnchor');
    expect(budgeted[2]).toContain('rv:language');
    expect(seen.find(query => query.sparql === accessQuery)?.budgeted).toBe(false);
    expect(seen.find(query => query.sparql.includes('restoreHold'))?.budgeted).toBe(false);
  });
});

test('draft GET refuses an unreadable contribution before the exact-draft queries', async () => {
  await withDirectory(async directory => {
    const seen: string[] = [];
    const fuseki = { query: async (sparql: string) => {
      seen.push(sparql);
      if (sparql.includes('ASK')) return { boolean: true };
      throw new Error(`draft graph was read after refusal: ${sparql.slice(0, 160)}`);
    } };
    const app = contributionRoutes(fuseki as unknown as FusekiClient, {
      environment: { fuseki, objectDirectory: directory,
        lineage: { dataEpoch: 'epoch-1', routingEpoch: '1' } },
      account: { verify: async () => ({ issuer: 'test', subject: 'member' }) },
      access: { canReadContributionDraft: async () => false },
    } as unknown as MainWorkDependencies);
    const response = await app.handle(new Request(
      `http://main.local/v1/contributions/${id(contribution)}/drafts/${id(revision)}?actingSubject=${encodeURIComponent(author)}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'revision_unavailable' });
    expect(seen.some(sparql => sparql.includes('RevisionAnchor'))).toBe(false);
    expect(seen.some(sparql => sparql.includes('schema:CreativeWork'))).toBe(false);
  });
});
