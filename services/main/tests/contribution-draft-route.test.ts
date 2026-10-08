import { expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fusekiReadBudget, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_PROFILE, textContributionDigest, textContributionReceiptIri }
  from '../src/modules/contribution/draft.ts';
import { DATASET, RV, prepareComponent, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { contributionRoutes } from '../src/routes/contributions.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000011';
const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000012';
const contribution = 'https://rezics.com/id/00000000-0000-4000-8000-000000000014';
const revision = 'https://rezics.com/id/00000000-0000-4000-8000-000000000015';
const operation = 'https://rezics.com/id/00000000-0000-4000-8000-000000000019';
const admission = '00000000-0000-4000-8000-000000000017';
const body = 'Best the day after baking.';
const language = 'en';
const epoch = 'epoch-1';
const sequence = '4';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const id = (iri: string) => iri.slice('https://rezics.com/id/'.length);

type GraphTerm = { type: 'uri' | 'literal'; value: string; datatype?: string };

/** Fifteen subject terms: acceptance rejects a create receipt with any other count. */
function originalCreateReceipt(digest: string): { p: GraphTerm; o: GraphTerm }[] {
  const uri = (value: string): GraphTerm => ({ type: 'uri', value });
  const plain = (value: string): GraphTerm => ({ type: 'literal', value, datatype: XSD_STRING });
  const terms: Record<string, GraphTerm> = {
    [RDF_TYPE]: uri(`${RV}OperationReceipt`),
    [`${RV}operation`]: uri(operation),
    [`${RV}requestDigest`]: plain(digest),
    [`${RV}admissionId`]: plain(admission),
    [`${RV}authorityEpoch`]: plain('0'),
    [`${RV}admittedScope`]: plain(`contribution:create:${work}`),
    [`${RV}outcome`]: uri(`${RV}Succeeded`),
    [`${RV}work`]: uri(work),
    [`${RV}contribution`]: uri(contribution),
    [`${RV}draftRevision`]: uri(revision),
    [`${RV}language`]: plain(language),
    [`${RV}author`]: uri(author),
    [`${RV}datasetId`]: uri(DATASET),
    [`${RV}dataEpoch`]: plain(epoch),
    [`${RV}sequence`]: { type: 'literal', value: sequence, datatype: XSD_INTEGER },
  };
  return Object.entries(terms).map(([predicate, object]) => ({ p: uri(predicate), o: object }));
}

async function withDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = join(import.meta.dir, '../../../.temp/contribution-draft-route', randomUUID());
  mkdirSync(directory, { recursive: true });
  try { return await run(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('draft GET spends the exact-draft budget on the current Work, the anchor, the identity and the create receipt', async () => {
  await withDirectory(async directory => {
    const manifestDigest = prepareComponent(directory, contribution, {
      work, author, language, body, publication: 'draft',
    }, CONTRIBUTION_PROFILE);
    const digest = textContributionDigest({ work, language, actingSubject: author, body });
    const receipt = textContributionReceiptIri(admission);
    const seen: { sparql: string; budgeted: boolean }[] = [];
    const fuseki = { query: async (sparql: string) => {
      seen.push({ sparql, budgeted: fusekiReadBudget.getStore() !== undefined });
      if (sparql.includes('RevisionAnchor')) return { results: { bindings: [{
        component: { type: 'uri', value: contribution },
        manifest: { type: 'uri', value: `urn:rezics:sha256:${manifestDigest}` },
        model: { type: 'uri', value: CONTRIBUTION_PROFILE },
        shape: { type: 'uri', value: CONTRIBUTION_PROFILE },
        dataset: { type: 'uri', value: DATASET },
        epoch: { type: 'literal', value: epoch },
        sequence: { type: 'literal', value: sequence },
      }] } };
      if (sparql.includes('ASK')) return { boolean: true };
      if (sparql.includes('SELECT ?receipt')) {
        return { results: { bindings: [{ receipt: { type: 'uri', value: receipt } }] } };
      }
      if (sparql.includes('SELECT ?p ?o') && sparql.includes(receipt)) {
        return { results: { bindings: originalCreateReceipt(digest) } };
      }
      throw new Error(`unexpected draft query: ${sparql.slice(0, 160)}`);
    } };
    const environment = { fuseki, objectDirectory: directory,
      lineage: { dataEpoch: epoch, routingEpoch: '1' } } as unknown as WorkActivationEnvironment;
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
    expect(budgeted).toHaveLength(5);
    expect(budgeted[0]).toContain('schema:CreativeWork');
    expect(budgeted[1]).toContain('RevisionAnchor');
    expect(budgeted[2]).toContain('rv:language');
    expect(budgeted[3]).toContain('rv:OperationReceipt');
    expect(budgeted[4]).toContain(receipt);
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
