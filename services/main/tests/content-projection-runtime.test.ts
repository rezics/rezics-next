import { expect, test } from 'bun:test';
import type { ContentCore } from '../../content/src/core.ts';
import type { ContentProjectionCursor } from '../../content/src/projection-cursor.ts';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { ContentProjectionWorker } from '../src/content-projection-worker.ts';
import { currentWorkerTick } from '../src/worker-tick.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { contentSearchEligibilityDecisionIri, contentSearchEligibilityDigest,
  contentSearchEligibilityReceiptIri } from '../src/modules/content-publication/eligibility.ts';
import { contentPublicationDecisionIri, contentPublicationReceiptIri }
  from '../src/modules/content-publication/publish.ts';
import { DATASET, RV } from '../src/modules/work/activate.ts';

const graphEpoch = 'graph-epoch';
const contentEpoch = 'content-epoch';
const generation = 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const contentPosition = (sequence: string) => ({ owner: 'content' as const,
  dataEpoch: contentEpoch, sequence });
const binding = (value: string) => ({ type: 'literal', value });
const integer = (value: string) => ({ type: 'literal', value, datatype: XSD_INTEGER });
const uri = (value: string) => ({ type: 'uri', value });
const contentVariant = 'urn:rezics:variant:1';
const contentResource = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const contentRevision = 'urn:rezics:content:revision:11111111-1111-4111-8111-111111111111';
const publicationAdmission = '22222222-2222-4222-8222-222222222222';
const eligibilityAdmission = '33333333-3333-4333-8333-333333333333';
const publication = contentPublicationDecisionIri(publicationAdmission);
const publicationReceipt = contentPublicationReceiptIri(publicationAdmission);
const eligibility = contentSearchEligibilityDecisionIri(eligibilityAdmission);
const eligibilityReceipt = contentSearchEligibilityReceiptIri(eligibilityAdmission);
const actor = 'urn:rezics:actor:content-search-reviewer';
const preparation = '44444444-4444-4444-8444-444444444444';
const eligibilityInput = { resourceId: contentResource, variantId: contentVariant,
  publicationDecision: publication, expectedEligibilityHead: null, actingSubject: actor,
  rightsBasis: 'original-contribution' as const, disclosure: 'public' as const };

function proofRow(key: string, id: string, receipt: string,
  fields: Array<[string, string | undefined, 'uri' | 'literal']>) {
  const row: Record<string, { type: string; value: string }> = { [key]: uri(id),
    decisionTypeCount: integer('1'), anchorTypeCount: integer('1'), receiptCount: integer('1'),
    receipt: uri(receipt), receiptTypeCount: integer('1') };
  for (const [name, value, type] of fields) {
    row[`${name}Count`] = integer(value === undefined ? '0' : '1');
    if (value !== undefined) row[name] = type === 'uri' ? uri(value)
      : name === 'dSequence' || name === 'rSequence' ? integer(value) : binding(value);
  }
  return row;
}

const publicationOwnerRow = proofRow('publication', publication, publicationReceipt, [
  ['dComponent', contentVariant, 'uri'], ['dResource', contentResource, 'uri'],
  ['dRevision', contentRevision, 'uri'], ['dDigest', 'a'.repeat(64), 'literal'],
  ['dOwnerEpoch', contentEpoch, 'literal'], ['dOwnerSequence', '2', 'literal'],
  ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '6', 'literal'],
  ['dModel', 'https://rezics.com/definition/content-publication-v1', 'uri'],
  ['dShape', 'https://rezics.com/definition/content-publication-v1', 'uri'],
  ['dDataset', DATASET, 'uri'], ['dPreparation', preparation, 'literal'],
  ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
  ['rRequestDigest', 'b'.repeat(64), 'literal'], ['rAdmissionId', publicationAdmission, 'literal'],
  ['rAuthorityEpoch', '2', 'literal'], ['rScope', `content:publish:${contentVariant}`, 'literal'],
  ['rPreparation', preparation, 'literal'], ['rRevision', contentRevision, 'uri'],
  ['rVariant', contentVariant, 'uri'], ['rResource', contentResource, 'uri'],
  ['rByteDigest', 'a'.repeat(64), 'literal'], ['rOwnerEpoch', contentEpoch, 'literal'],
  ['rOwnerSequence', '2', 'literal'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
  ['rDataset', DATASET, 'uri'], ['rDataEpoch', graphEpoch, 'literal'],
  ['rSequence', '6', 'literal'], ['rDecision', publication, 'uri'],
]);

const eligibilityOwnerRow = proofRow('eligibility', eligibility, eligibilityReceipt, [
  ['dComponent', contentVariant, 'uri'], ['dVariant', contentVariant, 'uri'],
  ['dResource', contentResource, 'uri'], ['dPublication', publication, 'uri'],
  ['dRightsBasis', `${RV}OriginalContribution`, 'uri'], ['dAssessment', undefined, 'uri'],
  ['dDisclosure', `${RV}Public`, 'uri'], ['dAdmissionId', eligibilityAdmission, 'literal'],
  ['dAuthorityEpoch', '2', 'literal'], ['dScope', `content:search-eligibility:${contentVariant}`, 'literal'],
  ['dActor', actor, 'uri'], ['dModel', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
  ['dShape', 'https://rezics.com/definition/content-search-eligibility-v1', 'uri'],
  ['dDataset', DATASET, 'uri'], ['dDataEpoch', graphEpoch, 'literal'], ['dSequence', '7', 'literal'],
  ['rOutcome', `${RV}Succeeded`, 'uri'], ['rReason', undefined, 'uri'],
  ['rRequestDigest', contentSearchEligibilityDigest(eligibilityInput), 'literal'],
  ['rAdmissionId', eligibilityAdmission, 'literal'], ['rAuthorityEpoch', '2', 'literal'],
  ['rScope', `content:search-eligibility:${contentVariant}`, 'literal'], ['rActor', actor, 'uri'],
  ['rResource', contentResource, 'uri'], ['rVariant', contentVariant, 'uri'],
  ['rPublication', publication, 'uri'], ['rExpectedHead', 'urn:rezics:none', 'uri'],
  ['rRightsBasis', `${RV}OriginalContribution`, 'uri'], ['rAssessment', undefined, 'uri'],
  ['rDisclosure', `${RV}Public`, 'uri'], ['rDataset', DATASET, 'uri'],
  ['rDataEpoch', graphEpoch, 'literal'], ['rSequence', '7', 'literal'], ['rEligibility', eligibility, 'uri'],
]);

class SearchFuseki extends FusekiClient {
  available = true;
  missing = false;
  instanceId = '11111111-1111-4111-8111-111111111111';
  publicSearchWriteEpoch = '0';
  contentAudits = 0;
  occurrenceLabelsPending = false;
  constructor() { super('http://127.0.0.1:1/rezics'); }
  override async commandHealth() {
    return { moduleVersion: 'test', instanceId: this.instanceId,
      publicSearchWriteEpoch: this.publicSearchWriteEpoch, publicSearchWriteActive: false,
      profiles: Object.fromEntries(Object.entries(profileRegistry)
      .map(([id, profile]) => [id, profile.sha256])) };
  }
  override async query(sparql: string): Promise<SparqlResult> {
    if (!this.available) throw new Error('graph unavailable');
    if (sparql.includes('ASK {')) return { boolean: true };
    if (sparql.includes('SELECT ?generation WHERE') && sparql.includes('"occurrence-lucene-v1"')) {
      return { results: { bindings: this.occurrenceLabelsPending
        ? [{ generation: binding('urn:rezics:generation:1') }] : [] } };
    }
    if (sparql.includes('SELECT ?epoch ?routing ?sequence WHERE')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), routing: binding('1'), sequence: integer('7') }] } };
    }
    if (sparql.includes('(COUNT(DISTINCT ?resource) AS ?resourceCount)')) {
      return { results: { bindings: [{ variant: uri(contentVariant), resourceCount: integer('1'),
        resource: uri(contentResource), publicationCount: integer('1'), publication: uri(publication),
        eligibilityCount: integer('1'), eligibility: uri(eligibility) }] } };
    }
    if (sparql.includes('SELECT ?eligibility') && sparql.includes('?decisionTypeCount')) {
      return { results: { bindings: [eligibilityOwnerRow] } };
    }
    if (sparql.includes('SELECT ?publication') && sparql.includes('?decisionTypeCount')) {
      return { results: { bindings: [publicationOwnerRow] } };
    }
    if (sparql.includes('?probeScore')) {
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: integer('7'),
        generation: binding(generation), population: binding('1') }] } };
    }
    if (sparql.includes('rv:publicTextInventory()')) {
      return { results: { bindings: [{ population: binding('1') }] } };
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?generation ?declared')) {
      this.contentAudits++;
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: integer('7'),
        generation: binding(generation), declared: binding('1'), heads: binding('1'),
        missing: binding(this.missing ? '1' : '0'),
        eligible: binding(this.missing ? '0' : '1'),
        contentUnits: binding(this.missing ? '0' : '1'),
      }] } };
    }
    if (sparql.includes('?candidateCount')) {
      const match = sparql.includes('needle');
      return { results: { bindings: [{ epoch: binding(graphEpoch), sequence: integer('7'),
        generation: binding(generation), candidateCount: binding(match ? '1' : '0'),
        ...(match ? { unit: binding('urn:rezics:match:1'), score: binding('2.5'),
          resource: binding(contentResource), variant: binding(contentVariant), revision: binding(contentRevision),
          decision: binding(publication), language: binding('en'),
          eligibility: binding(eligibility),
          rightsBasis: binding(`${RV}OriginalContribution`) } : {}) }] } };
    }
    throw new Error(`unexpected query: ${sparql.slice(0, 80)}`);
  }
}

function fixture() {
  const fuseki = new SearchFuseki();
  let source = '2';
  let checkpoint = '2';
  const content = { ownerPosition: async () => contentPosition(source) } as ContentCore;
  const cursor = { read: async () => contentPosition(checkpoint) } as unknown as ContentProjectionCursor;
  const app = createMainApp(fuseki, { environment: {
    fuseki, lineage: { dataEpoch: graphEpoch, routingEpoch: '1' }, objectDirectory: '.temp/unused',
  }, access: { assertRecoveryOpen: async () => undefined },
  contentProjection: { content, cursor, consumer: 'public-search' } } as unknown as MainWorkDependencies);
  const search = (phrase: string, language: string | null = null) => app.handle(new Request('http://localhost/v1/queries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: 'public-content-phrase-v1', phrase, language }),
  }));
  const readiness = () => app.handle(new Request('http://localhost/health/search-ready'));
  return { fuseki, search, readiness, setSource: (value: string) => { source = value; },
    setCheckpoint: (value: string) => { checkpoint = value; } };
}

test('SEARCH19: Content phrase route returns a typed complete result at both source positions', async () => {
  const run = fixture();
  const response = await run.search('needle');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ contractVersion: '1',
    profile: 'public-content-phrase-v1', resultGrain: 'content-variant', complete: true,
    total: 1, population: 1, graphPosition: { dataEpoch: graphEpoch, sequence: '7' },
    contentPosition: contentPosition('2'), indexGeneration: generation,
    results: [{ matchUnit: 'urn:rezics:match:1', score: 2.5 }] });
  const readiness = await run.readiness();
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toEqual({ status: 'ready', dataEpoch: graphEpoch,
    sequence: '7', indexGeneration: generation,
    occurrenceLabels: { status: 'current', pending: { value: 0, kind: 'at-least' } } });
});

test('SEARCH19: Content readiness reports occurrence label lag without hiding a complete Content result', async () => {
  const run = fixture();
  run.fuseki.occurrenceLabelsPending = true;
  expect((await run.search('needle')).status).toBe(200);
  const readiness = await run.readiness();
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toEqual({ status: 'indexing', dataEpoch: graphEpoch,
    sequence: '7', indexGeneration: generation,
    occurrenceLabels: { status: 'indexing', pending: { value: 1, kind: 'at-least' } } });
});

test('SEARCH15/SEARCH19: Content inventory is reaudited after JVM restart or public write rollback', async () => {
  const run = fixture();
  expect((await run.search('needle')).status).toBe(200);
  expect((await run.search('needle')).status).toBe(200);
  expect(run.fuseki.contentAudits).toBe(1);

  run.fuseki.publicSearchWriteEpoch = '2';
  run.fuseki.missing = true;
  const rolledBack = await run.search('needle');
  expect(rolledBack.status).toBe(503);
  expect((await rolledBack.json() as { code: string }).code).toBe('content_projection_unavailable');
  expect(run.fuseki.contentAudits).toBe(2);

  run.fuseki.missing = false;
  run.fuseki.instanceId = '22222222-2222-4222-8222-222222222222';
  expect((await run.search('needle')).status).toBe(200);
  expect(run.fuseki.contentAudits).toBe(3);
});

test('SEARCH19: Content route and readiness fail closed on lag and graph outage', async () => {
  const run = fixture();
  run.setCheckpoint('1');
  const lagged = await run.search('needle');
  expect(lagged.status).toBe(503);
  expect((await lagged.json() as { code: string }).code).toBe('content_projection_unavailable');
  expect((await run.readiness()).status).toBe(503);
  run.setCheckpoint('2');
  run.fuseki.missing = true;
  expect((await run.search('needle')).status).toBe(503);
  expect((await run.readiness()).status).toBe(503);
  run.fuseki.missing = false;
  run.fuseki.available = false;
  expect((await run.search('needle')).status).toBe(503);
  expect((await run.readiness()).status).toBe(503);
  run.fuseki.available = true;
  expect((await run.search('x')).status).toBe(400);
  run.setSource('3');
  expect((await run.search('needle')).status).toBe(503);
});

test('SEARCH19/OPS16: worker retries a failed poll and restarted instance resumes its checkpoint', async () => {
  let checkpoint = 0;
  let attempts = 0;
  const ticks: (string | undefined)[] = [];
  const errors: unknown[] = [];
  let completed!: () => void;
  const firstProgress = new Promise<void>(resolve => { completed = resolve; });
  const poll = async () => {
    ticks.push(currentWorkerTick());
    await Promise.resolve();
    ticks.push(currentWorkerTick());
    attempts++;
    if (attempts === 1) throw new Error('temporary graph failure');
    if (checkpoint === 0) {
      checkpoint = 1;
      completed();
      return { sourceEpoch: contentEpoch, sourceSequence: '1' as const, disposition: 'ignored' as const };
    }
    return null;
  };
  const worker = new ContentProjectionWorker(poll, 100, error => errors.push(error));
  worker.start();
  try { await firstProgress; }
  finally { await worker.stop(); }
  expect(errors).toHaveLength(1);
  expect(attempts).toBeGreaterThanOrEqual(2);
  expect(checkpoint).toBe(1);
  expect(ticks.length).toBeGreaterThanOrEqual(4);
  expect(ticks.every(tick => tick === 'main.content.projection')).toBe(true);
  expect(currentWorkerTick()).toBeUndefined();
  const restarted = new ContentProjectionWorker(async () => {
    expect(currentWorkerTick()).toBe('main.content.projection');
    const next = ++checkpoint;
    return { sourceEpoch: contentEpoch, sourceSequence: String(next), disposition: 'ignored' };
  });
  expect((await restarted.pollOnce())?.sourceSequence).toBe('2');
  expect(checkpoint).toBe(2);
});


test('Content phrase filters accept the same BCP 47 extensions as admitted bodies', async () => {
  const run = fixture();
  expect((await run.search('needle', 'en-US-u-nu-latn')).status).toBe(200);
  expect((await run.search('needle', 'EN-us-u-nu-latn')).status).toBe(200);
  expect((await run.search('needle', 'en-u')).status).toBe(400);
});
