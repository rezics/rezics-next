import { afterEach, expect, test } from 'bun:test';
import { documentText } from '@rezics/document';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import publication from '../../../../tests/qa/fixtures/outcomes/zone/publication.json';
import { spaceHref } from '../address/path.ts';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { RecordedSelection } from '../stories/recorded-fetch.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import type { ZoneSiteRecordedLoad } from '../zones/zone-site-recorded-page.ts';
import { readZoneManagementFrame } from './authoring-reads.ts';
import { zoneManagementReturnAddress } from './management-address.ts';
import { zoneHomeDocument } from './home-document.tsx';
import { readZonePublicationRecorded, recordedActingPerson } from './zone-publication-recorded-page.ts';

const record = publication as AnswerRecord;
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

const publicPersonas = ['visitor', 'stranger', 'member', 'moderator', 'operator'] as const;

function sample(persona: AnswerPersona, label: string) {
  const found = record.personas[persona].filter(item => item.label === label);
  if (found.length !== 1) throw new Error(`Expected one recorded sample: ${record.row}/${persona}/${label}`);
  return found[0]!;
}

interface HomeReference {
  resourceId: string;
  variantId: string;
  revisionId: string;
  byteDigest: string;
  provenance: { rightsBasis: string; author: string };
}

interface HomeAnswer {
  name: string;
  revision: string;
  address: { prefix: string; key: string; suffixSource: string };
  home?: { reference?: Partial<HomeReference> };
  navigation: { segment: string; name: { value: string } }[];
  presentation: { tokens: { pageSurface: string; density: string } };
}

function homeAnswer(persona: AnswerPersona, label: string): HomeAnswer {
  const answer = sample(persona, label).answer;
  if (!answer || typeof answer !== 'object') throw new Error(`Recorded ${persona}/${label} has no answer`);
  return answer as HomeAnswer;
}

function referenceOf(value: unknown, label: string): HomeReference {
  if (!value || typeof value !== 'object' || !('resourceId' in value)) throw new Error(`${label} has no content reference`);
  const reference = value as Partial<HomeReference>;
  const provenance = reference.provenance;
  if (typeof reference.resourceId !== 'string' || typeof reference.variantId !== 'string'
    || typeof reference.revisionId !== 'string' || typeof reference.byteDigest !== 'string'
    || typeof provenance?.rightsBasis !== 'string' || typeof provenance.author !== 'string') {
    throw new Error(`${label} reference is missing page identity or credit`);
  }
  return {
    resourceId: reference.resourceId, variantId: reference.variantId, revisionId: reference.revisionId,
    byteDigest: reference.byteDigest, provenance: { rightsBasis: provenance.rightsBasis, author: provenance.author },
  };
}

function receipt(label: string) {
  const answer = sample('owner', label).answer as {
    revision?: unknown; zone?: unknown; homeDocument?: unknown; replayed?: unknown;
    pages?: { page?: unknown; variantId?: unknown; revisionId?: unknown; byteDigest?: unknown }[];
  };
  const page = answer.pages?.length === 1 ? answer.pages[0] : undefined;
  if (typeof answer.revision !== 'string' || typeof answer.zone !== 'string' || typeof answer.homeDocument !== 'string'
    || typeof answer.replayed !== 'boolean' || typeof page?.page !== 'string' || typeof page.variantId !== 'string'
    || typeof page.revisionId !== 'string' || typeof page.byteDigest !== 'string') {
    throw new Error(`Recorded owner/${label} is not a publication receipt`);
  }
  return {
    revision: answer.revision, zone: answer.zone, homeDocument: answer.homeDocument, replayed: answer.replayed,
    page: { page: page.page, variantId: page.variantId, revisionId: page.revisionId, byteDigest: page.byteDigest },
  };
}

async function replay(persona: AnswerPersona, selections: readonly RecordedSelection[]): Promise<ZoneSiteRecordedLoad> {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const loaded = await readZonePublicationRecorded(transport.fetcher, record, persona, selections);
  if (loaded.mapped.kind === 'discrepancy') throw new Error(loaded.mapped.detail);
  return loaded;
}

function expectPublished(loaded: ZoneSiteRecordedLoad, answer: HomeAnswer) {
  const document = zoneHomeDocument(answer.home);
  if (!document) throw new Error('recorded presentation home is not a readable document');
  const reference = referenceOf(answer.home?.reference, 'presentation');
  const shown = loaded.presentation?.home;
  if (!shown) throw new Error('published presentation has no home');
  expect(referenceOf(shown.reference, 'loaded presentation')).toEqual(reference);
  expect(loaded.mapped).toEqual({
    kind: 'published', name: answer.name, text: documentText(document),
    credit: { rightsBasis: reference.provenance.rightsBasis, author: reference.provenance.author, revisionId: reference.revisionId },
    page: shown,
  });
  const surface = answer.presentation.tokens.pageSurface;
  const density = answer.presentation.tokens.density;
  if (surface !== 'flat' && surface !== 'cards') throw new Error(`Recorded page surface ${surface} is not a site surface`);
  if (density !== 'comfortable' && density !== 'compact') throw new Error(`Recorded density ${density} is not a site density`);
  expect(loaded.presentation?.revision).toBe(answer.revision);
  expect(loaded.presentation?.address).toEqual(answer.address);
  expect(loaded.presentation?.navigation.map(item => item.segment)).toEqual(answer.navigation.map(item => item.segment));
  expect(loaded.presentation?.presentation.tokens.pageSurface).toBe(surface);
  expect(loaded.presentation?.presentation.tokens.density).toBe(density);
  return reference;
}

for (const persona of publicPersonas) {
  test(`${persona} public reread keeps the owner's published cut`, async () => {
    const published = homeAnswer(persona, 'published-presentation');
    const unchanged = homeAnswer(persona, 'unchanged-public-presentation');
    const before = await replay(persona, [{ label: 'published-presentation', state: 'populated' }]);
    const after = await replay(persona, [{ label: 'unchanged-public-presentation', state: 'populated' }]);
    const reference = expectPublished(before, published);
    expectPublished(after, unchanged);
    expect(after.mapped).toEqual(before.mapped);
    expect(reference.provenance).toEqual({
      rightsBasis: 'original-contribution',
      author: actingSubject('owner', 'manage-configuration'),
    });
    expect(sample(persona, 'published-presentation').path).not.toContain('actingSubject');
    expect(sample(persona, 'unchanged-public-presentation').path).not.toContain('actingSubject');
    expect(recordedActingPerson(record, persona, [{ label: 'published-presentation', state: 'populated' }])).toBeNull();
  });
}

test('visitor empty publication stays empty', async () => {
  const answer = homeAnswer('visitor', 'empty-home-presentation');
  const loaded = await replay('visitor', [{ label: 'empty-home-presentation', state: 'empty' }]);
  expect(loaded.mapped).toEqual({ kind: 'empty', name: answer.name });
  expect(answer.home).toBeUndefined();
  expect(loaded.presentation?.home).toBeUndefined();
  expect(loaded.presentation?.address).toEqual(answer.address);
  expect(loaded.presentation?.navigation).toEqual([]);
});

test('visitor missing draft route stays the recorded refusal', async () => {
  const refused = sample('visitor', 'published-draft-route-refused');
  const problem = refused.answer as { title: string; code: string };
  const address = sample('visitor', 'site-address').answer as { canonical: { prefix: string; key: string; suffixSource: string } };
  const loaded = await replay('visitor', [
    { label: 'site-address', state: 'populated' },
    { label: 'published-draft-route-refused', state: 'error' },
  ]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: refused.status, title: problem.title, code: problem.code },
  });
  expect(refused.status).toBe(404);
  expect(problem).toMatchObject({ title: 'Zone route is unavailable', code: 'route_missing', status: 404 });
  expect(new URL(refused.path, 'https://recorded.invalid').searchParams.get('path')).toBe('/draft-link');
  expect(loaded.address?.canonical).toEqual(address.canonical);
  expect(loaded.presentation).toBeNull();
  expect(recordedActingPerson(record, 'visitor', [{ label: 'site-address', state: 'populated' }])).toBeNull();
});

test('owner selected publication is the replayed receipt cut', async () => {
  const acknowledged = receipt('publication-acknowledgement');
  const replayed = receipt('receipt-replay');
  const original = receipt('original-receipt-replay');
  expect(replayed).toEqual({ ...acknowledged, replayed: true });
  expect(original).toEqual(replayed);
  const answer = homeAnswer('owner', 'selected-presentation');
  const loaded = await replay('owner', [{ label: 'selected-presentation', state: 'populated' }]);
  const reference = expectPublished(loaded, answer);
  expect(reference).toMatchObject({
    resourceId: acknowledged.homeDocument,
    variantId: acknowledged.page.variantId,
    revisionId: acknowledged.page.revisionId,
    byteDigest: acknowledged.page.byteDigest,
  });
  expect(reference.resourceId).not.toBe(acknowledged.zone);
  expect(loaded.presentation?.revision).toBe(acknowledged.revision);
  expect(sample('owner', 'selected-presentation').path).not.toContain('actingSubject');
});

test('competing publication stays public after the original receipt is replayed', async () => {
  const acknowledged = receipt('publication-acknowledgement');
  const competing = receipt('competing-publication');
  const exact = sample('owner', 'competing-exact-content');
  const exactReference = referenceOf((exact.answer as { reference?: unknown }).reference, 'competing content');
  expect(exact.path).toBe(`/v1/content-revisions/${competing.page.revisionId}`);
  expect(exactReference).toMatchObject({
    resourceId: competing.page.page,
    variantId: competing.page.variantId,
    revisionId: competing.page.revisionId,
    byteDigest: competing.page.byteDigest,
    provenance: { rightsBasis: 'original-contribution', author: actingSubject('owner', 'manage-configuration') },
  });
  const current = homeAnswer('owner', 'competing-presentation');
  const stayed = homeAnswer('owner', 'unchanged-competing-presentation');
  const loaded = await replay('owner', [
    { label: 'competing-presentation', state: 'populated' },
    { label: 'competing-exact-content', state: 'populated' },
  ]);
  const again = await replay('owner', [{ label: 'unchanged-competing-presentation', state: 'populated' }]);
  const reference = expectPublished(loaded, current);
  expectPublished(again, stayed);
  expect(again.mapped).toEqual(loaded.mapped);
  expect(reference.revisionId).toBe(competing.page.revisionId);
  expect(reference.byteDigest).toBe(competing.page.byteDigest);
  expect(loaded.presentation?.revision).toBe(competing.revision);
  expect(loaded.presentation?.revision).not.toBe(acknowledged.revision);
  expect(reference.revisionId).not.toBe(acknowledged.page.revisionId);
});

test('superseded receipt revision stays concealed', async () => {
  const acknowledged = receipt('publication-acknowledgement');
  const refused = sample('owner', 'superseded-content-refused');
  const problem = refused.answer as { title: string; code: string };
  const loaded = await replay('owner', [{ label: 'superseded-content-refused', state: 'error' }]);
  expect(loaded.mapped).toEqual({
    kind: 'refusal',
    problem: { status: refused.status, title: problem.title, code: problem.code },
  });
  expect(refused.status).toBe(404);
  expect(problem).toMatchObject({ title: 'Revision is unavailable', code: 'revision_unavailable', status: 404 });
  expect(refused.path).toBe(`/v1/content-revisions/${acknowledged.page.revisionId}`);
  expect(loaded.presentation).toBeNull();
});

const refusedManagement = ['stranger', 'member', 'moderator', 'operator'] as const;

function managementClient(persona: AnswerPersona, selections: readonly RecordedSelection[]) {
  const transport = recordedFetch(record, persona, selections, { pathPrefix: BFF_PREFIX });
  disposals.push(transport.dispose);
  const configuration: string[] = [];
  const fetcher: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'https://recorded.invalid');
    if (url.pathname.endsWith('/configuration')) configuration.push(url.pathname.slice(BFF_PREFIX.length) + url.search);
    return transport.fetcher(input, init);
  }, { preconnect: globalThis.fetch.preconnect });
  return { client: browserMainApi('https://recorded.invalid', { fetcher }), configuration };
}

function actingSubject(persona: AnswerPersona, label: string): string {
  const acting = new URL(sample(persona, label).path, 'https://recorded.invalid').searchParams.get('actingSubject');
  if (!acting) throw new Error(`Recorded ${persona}/${label} has no acting Person`);
  return acting;
}

test('owner management read opens the recorded editor', async () => {
  const persona = 'owner' as const;
  const acting = actingSubject(persona, 'manage-configuration');
  const zoneId = new URL(sample(persona, 'manage-configuration').path, 'https://recorded.invalid').pathname.split('/')[3]!;
  const replayed = receipt('receipt-replay');
  const address = sample(persona, 'manage-space-address').answer as { canonical: Parameters<typeof spaceHref>[0] };
  const configuration = sample(persona, 'manage-configuration');
  const configured = configuration.answer as { revision: string; name: string; configuration: { space: string; state: string } };
  const transport = managementClient(persona, [
    { label: 'manage-configuration', state: 'populated' },
    { label: 'manage-space-address', state: 'populated' },
    { label: 'site-editor-access', state: 'populated' },
    { label: 'manage-zone', state: 'populated' },
  ]);
  const frame = await readZoneManagementFrame(transport.client, zoneId, 'en', acting);
  expect(transport.configuration).toEqual([configuration.path]);
  const loaded = frame.authoring;
  expect(loaded.kind).toBe('ready');
  if (loaded.kind !== 'ready') return;
  expect(acting).toBe(actingSubject('owner', 'manage-configuration'));
  expect(loaded.model.name).toBe(configured.name);
  expect(loaded.model.zoneId).toBe(zoneId);
  expect(loaded.model.zoneIri).toBe(`https://rezics.com/id/${zoneId}`);
  expect(loaded.model.state.variantId).toBe(replayed.page.variantId);
  expect(loaded.model.state.basis).toMatchObject({
    revisionId: replayed.page.revisionId,
    byteDigest: replayed.page.byteDigest,
  });
  const ownerRevision = (sample(persona, 'manage-zone').answer as { ownerRevision: string }).ownerRevision;
  expect(loaded.model.state.zoneHead).toBe(ownerRevision);
  expect(loaded.sitePath).toBe(spaceHref(address.canonical, 'site'));
  expect(loaded.model.document).not.toBeNull();
  if (!loaded.model.document) return;
  expect<unknown>(loaded.model.document).toEqual((sample(persona, 'site-editor-access').answer as { draft: { document: unknown } }).draft.document);
  expect(configured.configuration.state).toBe('active');
  expect(frame.lifecycle).toMatchObject({
    kind: 'ready', zoneId, spaceId: configured.configuration.space.split('/').at(-1),
    revision: configured.revision, status: 'active', name: configured.name,
  });
  if (frame.lifecycle.kind !== 'ready') return;
  expect(frame.missing).toBe(false);
  expect(frame.name).toBe(loaded.model.name);
  expect(frame.draftZoneId).toBe(loaded.model.zoneId);
  expect(frame.lifecycleOnly).toBe(false);
  expect(frame.lifecycle.returnAddress).toBe(zoneManagementReturnAddress(zoneId, frame.lifecycle, {
    address: zoneId, space: configured.configuration.space,
  }));
  expect(frame.lifecycleAddress).toEqual({
    zoneId: frame.lifecycle.zoneId, spaceId: frame.lifecycle.spaceId, returnAddress: frame.lifecycle.returnAddress,
  });
});

for (const persona of refusedManagement) {
  test(`${persona} management read keeps the recorded refusal`, async () => {
    const configuration = sample(persona, 'manage-configuration');
    const problem = configuration.answer as { title?: string; code?: string; status?: number };
    const acting = actingSubject(persona, 'manage-configuration');
    expect(configuration.status).toBe(404);
    expect(problem).toMatchObject({ title: 'Zone is unavailable', code: 'zone_unavailable', status: 404 });
    const zoneId = new URL(configuration.path, 'https://recorded.invalid').pathname.split('/')[3]!;
    expect(configuration.path).toBe(`/v1/zones/${zoneId}/configuration?actingSubject=${encodeURIComponent(acting)}`);
    const transport = managementClient(persona, [
      { label: 'manage-configuration', state: 'error' },
      { label: 'site-address', state: 'populated' },
      { label: 'site-editor-access', state: 'error' },
      { label: 'manage-zone', state: 'error' },
    ]);
    const frame = await readZoneManagementFrame(transport.client, zoneId, 'en', acting);
    expect(transport.configuration).toEqual([configuration.path, configuration.path]);
    expect(frame.authoring).toEqual({ kind: 'failure', failure: 'denied' });
    expect(frame.lifecycle).toEqual({ kind: 'failure', failure: 'denied' });
    expect(frame.missing).toBe(false);
    expect(frame.name).toBe(zoneId);
    expect(frame.lifecycleOnly).toBe(false);
    expect(frame.draftZoneId).toBeNull();
    expect(frame.lifecycleAddress).toBeUndefined();
  });
}

test('a signed-in site read keeps its acting Person, and the anonymous reread does not', () => {
  expect(recordedActingPerson(record, 'stranger', [{ label: 'site-home-presentation', state: 'populated' }]))
    .toBe(actingSubject('stranger', 'site-home-presentation'));
  expect(recordedActingPerson(record, 'visitor', [{ label: 'site-home-presentation', state: 'populated' }])).toBeNull();
});
