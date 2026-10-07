import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { checkZoneSitePublication, InvalidZoneConfiguration, ZONE_SITE_PUBLICATION_COST,
  zonePublishedPageBinding } from '../src/modules/zone/config-format.ts';
import { publishZoneSite } from '../src/modules/zone/configuration.ts';
import { isZonePublishedPageRevision } from '../src/modules/zone/publication.ts';
import { openApiOperations } from '../src/routes/zones.ts';
import { rateLimitFamily } from '../src/modules/rate-limit/routes.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const ref = () => `https://rezics.com/id/${randomUUID()}`;
const page = () => ({ page: ref(), variantId: `urn:rezics:variant:${randomUUID()}`, revisionId: randomUUID() });
const selection = () => {
  const revision = ref();
  return { routesRevision: revision, navigationRevision: revision, pages: [page()] };
};

test('site publication selects exact bounded revisions and rejects duplicate variants or revisions', () => {
  const input = selection();
  expect(checkZoneSitePublication(input)).toEqual(input);
  for (const invalid of [
    { ...input, pages: [] },
    { ...input, pages: Array.from({ length: ZONE_SITE_PUBLICATION_COST.maxPages + 1 }, page) },
    { ...input, pages: [input.pages[0], input.pages[0]] },
    { ...input, pages: [input.pages[0], { ...page(), revisionId: input.pages[0]!.revisionId }] },
    { ...input, pages: [input.pages[0], { ...page(), variantId: input.pages[0]!.variantId }] },
    { ...input, pages: [{ ...page(), revisionId: 'draft-head' }] },
    { ...input, pages: [{ ...page(), variantId: 'foreign' }] },
    { ...input, pages: [{ ...page(), body: 'A second document store' }] },
  ]) expect(() => checkZoneSitePublication(invalid)).toThrow(InvalidZoneConfiguration);
  expect(checkZoneSitePublication({ ...input,
    pages: Array.from({ length: ZONE_SITE_PUBLICATION_COST.maxPages }, page) }).pages)
    .toHaveLength(ZONE_SITE_PUBLICATION_COST.maxPages);
});

test('malformed page selections fail before any admission or graph side effect', async () => {
  const unused = new Proxy({}, { get() { throw new Error('Invalid selection reached an owner'); } });
  await expect(publishZoneSite(unused as WorkActivationEnvironment,
    unused as Parameters<typeof publishZoneSite>[1], unused as Parameters<typeof publishZoneSite>[2],
    new Request('http://main.local'), { ...selection(), pages: [], zone: ref(), expectedHead: ref(),
      actingSubject: ref(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(InvalidZoneConfiguration);
  expect(await isZonePublishedPageRevision(unused as WorkActivationEnvironment, ref(), ref(), 'draft-head')).toBe(false);
});

test('membership keys distinguish Zone bundle, page and exact revision', () => {
  const bundle = ref(), other = ref(), saved = page();
  const key = zonePublishedPageBinding(bundle, saved.page, saved.revisionId);
  expect(zonePublishedPageBinding(bundle, saved.page, saved.revisionId)).toBe(key);
  expect(zonePublishedPageBinding(other, saved.page, saved.revisionId)).not.toBe(key);
  expect(zonePublishedPageBinding(bundle, other, saved.revisionId)).not.toBe(key);
  expect(zonePublishedPageBinding(bundle, saved.page, randomUUID())).not.toBe(key);
});

test('site publication is explicitly public, bearer authorized, idempotent and write limited', () => {
  expect(openApiOperations['/v1/zones/{id}/site-publications'].post).toEqual({
    rateLimitFamily: 'write', exposure: 'public', bearer: true, idempotencyKey: true,
  });
  expect(rateLimitFamily('POST', '/v1/zones/{id}/site-publications')).toBe('write');
});

import { Value } from 'typebox/value';
import { documentVersion, parseDocument, type DocumentNode, type JsonValue } from '@rezics/document';
import { checkZoneSitePublishSelection } from '../src/modules/zone/config-format.ts';
import { DEFAULT_ZONE_PRESENTATION, type ZonePresentation } from '../src/modules/zone/presentation-format.ts';
import { resolveZonePageDocument, ZonePageDocument, ZoneShowcasePayload, ZONE_SHOWCASE_BLOCK, ZONE_DOCUMENT_COST,
  ZONE_SHOWCASE_BLOCK_DEFINITION, ZONE_SHOWCASE_BLOCK_VERSION, ZoneLocalShowcasePayload,
  ZONE_LOCAL_SHOWCASE_BLOCK, zoneDocumentShowcase, zonePagePresentation }
  from '../src/modules/presentation/zone-document.ts';
import { WorkReadLimit } from '../src/modules/work/read-session.ts';

const extension = (id: string, payload: JsonValue = {},
  definition: string = ZONE_SHOWCASE_BLOCK_DEFINITION, version: string = ZONE_SHOWCASE_BLOCK_VERSION,
  type: 'extensionBlock' | 'extensionInline' = 'extensionBlock'): DocumentNode => ({
  type, attrs: { id, definition, version, payload, fallback: `Fallback for ${id}` },
});
const documentOf = (...content: DocumentNode[]) => parseDocument({
  version: documentVersion, profile: 'blocks', doc: { type: 'doc', content },
});

test('default Showcase resolves from the supplied published presentation without changing exact bytes', () => {
  const document = documentOf({ type: 'paragraph', attrs: { id: 'opening' },
    content: [{ type: 'text', text: 'Published home text' }] }, extension('showcase'));
  const bytes = JSON.stringify(document);
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
    slides: [{ id: 'published-slide', href: '/published', title: 'Published slide' }] };
  const result = resolveZonePageDocument(document, presentation, [], []);
  expect(result.document).toBe(document);
  expect(JSON.stringify(result.document)).toBe(bytes);
  expect(result.definitions).toEqual([ZONE_SHOWCASE_BLOCK]);
  expect(result.definitions[0]!.payloadSchema).toBe(ZoneShowcasePayload);
  expect(result.blocks).toEqual([{ id: 'showcase', definition: ZONE_SHOWCASE_BLOCK_DEFINITION,
    version: ZONE_SHOWCASE_BLOCK_VERSION, fallback: 'Fallback for showcase',
    status: 'resolved', kind: 'showcase', showcase: '$default' }]);
  expect(result.showcases).toEqual([{ id: '$default', module: null, sources: [] }]);
  expect(result.showcaseData).toEqual({ slides: presentation.slides, slideMedia: [] });
  expect(result.showcaseData.slides).toBe(presentation.slides);
  expect(result.cost).toMatchObject({ nodesVisited: 4, extensions: 1, showcases: 1,
    graphReads: 0, definitionExecutions: 0 });
  expect(result.cost.responseBytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
  expect(Value.Check(ZonePageDocument, { ...result,
    blocks: [{ ...result.blocks[0], status: 'executed' }] })).toBe(false);
});

test('unknown definitions, future versions and inline extensions are opaque preorder placeholders', () => {
  const opaque = { script: 'https://example.test/never-executed.js',
    retained: [null, false, { extra: 'original payload' }] };
  const document = documentOf(extension('unknown', opaque, 'https://example.test/unknown', '99'),
    { type: 'blockquote', attrs: { id: 'quoted' }, content: [extension('future', opaque,
      ZONE_SHOWCASE_BLOCK_DEFINITION, '99')] },
    { type: 'paragraph', attrs: { id: 'inline-parent' },
      content: [extension('inline', opaque, ZONE_SHOWCASE_BLOCK_DEFINITION, '1', 'extensionInline')] });
  const bytes = JSON.stringify(document);
  const result = resolveZonePageDocument(document, DEFAULT_ZONE_PRESENTATION, [], []);
  expect(result.document).toBe(document);
  expect(JSON.stringify(result.document)).toBe(bytes);
  expect(result.document.doc.content![0]!.attrs!.payload).toEqual(opaque);
  expect(result.blocks.map(block => ({ id: block.id, status: block.status,
    reason: block.status === 'placeholder' ? block.reason : null }))).toEqual([
    { id: 'unknown', status: 'placeholder', reason: 'unknown_definition' },
    { id: 'future', status: 'placeholder', reason: 'unsupported_version' },
    { id: 'inline', status: 'placeholder', reason: 'unknown_definition' },
  ]);
  expect(result.blocks.map(block => block.fallback)).toEqual([
    'Fallback for unknown', 'Fallback for future', 'Fallback for inline',
  ]);
  expect(result.showcases).toEqual([]);
  expect(result.cost.graphReads).toBe(0);
  expect(result.cost.definitionExecutions).toBe(0);
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
});

test('Showcase payload schema rejects malformed cardinality and retains invalid blocks as placeholders', () => {
  expect(Value.Check(ZoneShowcasePayload, {})).toBe(true);
  expect(Value.Check(ZoneShowcasePayload, { 'rv:module': ['hero'] })).toBe(true);
  const payloads: JsonValue[] = [null, 'hero', { 'rv:module': 'hero' }, { 'rv:module': [] },
    { 'rv:module': ['hero', 'other'] }, { 'rv:module': ['../foreign'] },
    { 'rv:module': ['hero'], executor: 'https://example.test/code' }];
  const document = documentOf(...payloads.map((payload, index) => extension(`invalid-${index}`, payload)));
  const bytes = JSON.stringify(document);
  const result = resolveZonePageDocument(document, DEFAULT_ZONE_PRESENTATION, [], []);
  for (const payload of payloads) expect(Value.Check(ZoneShowcasePayload, payload)).toBe(false);
  expect(result.blocks).toHaveLength(payloads.length);
  expect(result.blocks.every(block => block.status === 'placeholder'
    && block.reason === 'invalid_payload')).toBe(true);
  expect(result.showcases).toEqual([]);
  expect(JSON.stringify(result.document)).toBe(bytes);
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
});

test('repeated Showcase blocks deduplicate their data and preserve the selected published module source', () => {
  const hero = { id: 'hero', type: 'hero-carousel',
    title: 'Highlights', source: { kind: 'query-block', block: 'new-adoptions' } } satisfies ZonePresentation['modules'][number];
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [hero],
    slides: [{ id: 'published-slide', href: '/published' }] };
  const moduleData: Parameters<typeof resolveZonePageDocument>[2] = [{ id: 'hero', sources: [{
    source: hero.source, state: 'public-read', members: [],
  }] }];
  const slideMedia: Parameters<typeof resolveZonePageDocument>[3] = [{ id: 'published-slide',
    art: { landscape: null, portrait: null, cutout: null, logos: [] } }];
  const document = documentOf(extension('default-one'), extension('default-two'),
    extension('hero-one', { 'rv:module': ['hero'] }), extension('hero-two', { 'rv:module': ['hero'] }));
  const result = resolveZonePageDocument(document, presentation, moduleData, slideMedia);
  expect(result.blocks.map(block => block.status === 'resolved' ? block.showcase : null))
    .toEqual(['$default', '$default', 'hero', 'hero']);
  expect(result.showcases).toHaveLength(2);
  const selected = result.showcases.find(showcase => showcase.id === 'hero')!;
  expect(selected.module).toBe(hero);
  expect(selected.sources).toBe(moduleData[0]!.sources);
  expect(result.showcaseData.slides).toBe(presentation.slides);
  expect(result.showcaseData.slideMedia).toBe(slideMedia);
  expect(result.cost).toMatchObject({ extensions: 4, showcases: 2, graphReads: 0, definitionExecutions: 0 });
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
});

test('Showcase cannot select a missing module or a different published module type', () => {
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
    modules: [{ id: 'shelf', type: 'shelf', title: 'Shelf',
      source: { kind: 'query-block', block: 'new-adoptions' } }] };
  const document = documentOf(extension('missing', { 'rv:module': ['missing'] }),
    extension('wrong-kind', { 'rv:module': ['shelf'] }));
  const result = resolveZonePageDocument(document, presentation, [], []);
  expect(result.blocks.every(block => block.status === 'placeholder'
    && block.reason === 'missing_module')).toBe(true);
  expect(result.showcases).toEqual([]);
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
});

test('distinct Showcase modules serialize the shared slides and media only once per document', () => {
  const modules: ZonePresentation['modules'] = Array.from({ length: 24 }, (_, index) => ({
    id: `hero-${index}`, type: 'hero-carousel', title: `Highlights ${index}`,
    source: { kind: 'query-block', block: 'new-adoptions' },
  }));
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, modules,
    slides: [{ id: 'single-published-slide', title: 'Shared slide marker', href: '/published' }] };
  const document = documentOf(...modules.map((module, index) =>
    extension(`instance-${index}`, { 'rv:module': [module.id] })));
  const slideMedia: Parameters<typeof resolveZonePageDocument>[3] = [{ id: 'single-published-media',
    art: { landscape: null, portrait: null, cutout: null, logos: [] } }];
  const result = resolveZonePageDocument(document, presentation, [], slideMedia);
  const json = JSON.stringify(result);
  expect(result.showcases).toHaveLength(24);
  expect(result.showcases.every(showcase => !('slides' in showcase) && !('slideMedia' in showcase))).toBe(true);
  expect(json.split('Shared slide marker')).toHaveLength(2);
  expect(json.split('single-published-media')).toHaveLength(2);
  expect(result.showcaseData.slides).toBe(presentation.slides);
  expect(result.showcaseData.slideMedia).toBe(slideMedia);
  expect(result.cost.responseBytes).toBe(Buffer.byteLength(json, 'utf8'));
  expect(result.cost.responseBytes).toBeLessThan(ZONE_DOCUMENT_COST.maxResponseBytes);
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
});

test('oversized resolved module source data fails the document response byte bound', () => {
  const hero: ZonePresentation['modules'][number] = { id: 'hero', type: 'hero-carousel',
    title: 'Highlights', source: { kind: 'query-block', block: 'new-adoptions' } };
  const presentation: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION, modules: [hero] };
  const moduleData: Parameters<typeof resolveZonePageDocument>[2] = [{ id: 'hero', sources: [{
    source: { kind: 'query-block', block: 'new-adoptions' }, state: 'public-read',
    members: [{ work: ref(), selection: 'x'.repeat(ZONE_DOCUMENT_COST.maxResponseBytes) }],
  }] }];
  const document = documentOf(extension('hero', { 'rv:module': ['hero'] }));
  expect(() => resolveZonePageDocument(document, presentation, moduleData, []))
    .toThrow(WorkReadLimit);
});

const localShowcase = () => ({
  'rv:module': [{ id: 'hero', type: 'hero-carousel' as const, title: 'Curated Content highlight',
    source: { kind: 'query-block' as const, block: 'new-adoptions' } }],
  'rv:slides': [{ id: 'curated', href: '/curated', title: 'Original Content slide' }],
  'rv:titleEffect': ['outline' as const],
});

test('version 2 Showcase resolves its own module, slides and effect without following Zone configuration', () => {
  const payload = localShowcase();
  const document = documentOf(extension('curated', payload, ZONE_SHOWCASE_BLOCK_DEFINITION, '2'));
  const original = JSON.stringify(document);
  const shell: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
    modules: [{ ...payload['rv:module'][0]!, title: 'Conflicting Zone module', source: { kind: 'context', context: ref() } }],
    slides: [{ id: 'zone-slide', href: '/zone' }] };
  const data: NonNullable<Parameters<typeof resolveZonePageDocument>[4]> = { sources: [{
    source: payload['rv:module'][0]!.source, state: 'public-read', members: [],
  }], slideMedia: [{ id: 'curated', art: { landscape: null, portrait: null, cutout: null, logos: [] } }] };
  const result = resolveZonePageDocument(document, shell, [], [], data);
  expect(Value.Check(ZoneLocalShowcasePayload, payload)).toBe(true);
  expect(result.definitions).toEqual([ZONE_SHOWCASE_BLOCK, ZONE_LOCAL_SHOWCASE_BLOCK]);
  expect(result.showcases).toEqual([{ id: 'block:curated', module: payload['rv:module'][0],
    slides: payload['rv:slides'], titleEffect: 'outline', ...data }]);
  expect(result.blocks).toEqual([expect.objectContaining({ status: 'resolved', showcase: 'block:curated' })]);
  expect(zonePagePresentation(result, shell)).toEqual({ ...shell, modules: payload['rv:module'],
    slides: payload['rv:slides'], tokens: { ...shell.tokens, titleEffect: 'outline' } });
  expect(zonePagePresentation(result, shell).official).toBe(shell.official);
  expect(JSON.stringify(result.document)).toBe(original);
  expect(Value.Check(ZonePageDocument, result)).toBe(true);
  expect(result.cost.responseBytes).toBe(Buffer.byteLength(JSON.stringify(result), 'utf8'));
  const hidden = resolveZonePageDocument(document, shell, [], [], { ...data, slides: [], slideMedia: [] });
  expect(hidden.showcases[0]!.slides).toEqual([]);
  expect(zonePagePresentation(hidden, shell).slides).toEqual([]);
  expect(JSON.stringify(hidden.document)).toBe(original);
});

test('local payload cardinality and slide meaning fail to opaque placeholders with unchanged exports', () => {
  const valid = localShowcase();
  const invalid: JsonValue[] = [
    { 'rv:module': ['hero'] }, { ...valid, 'rv:module': [] }, { ...valid, 'rv:module': [valid['rv:module'][0]!, valid['rv:module'][0]!] },
    { ...valid, 'rv:module': [{ ...valid['rv:module'][0]!, type: 'shelf' }] },
    { ...valid, 'rv:titleEffect': [] }, { ...valid, 'rv:slides': [{ id: 'curated', href: '//external' }] },
    { ...valid, 'rv:slides': [valid['rv:slides'][0]!, valid['rv:slides'][0]!] },
    { ...valid, 'rv:slides': [{ id: 'scheduled', href: '/scheduled', startsAt: '2026-01-02T00:00:00.000Z',
      endsAt: '2026-01-01T00:00:00.000Z' }] },
    { ...valid, execute: 'https://example.test/never.js' },
  ];
  const document = documentOf(...invalid.map((payload, index) =>
    extension(`invalid-local-${index}`, payload, ZONE_SHOWCASE_BLOCK_DEFINITION, '2')));
  const bytes = JSON.stringify(document);
  expect(zoneDocumentShowcase(document)).toBeNull();
  const result = resolveZonePageDocument(document, DEFAULT_ZONE_PRESENTATION, [], []);
  expect(result.blocks.every(block => block.status === 'placeholder' && block.reason === 'invalid_payload')).toBe(true);
  expect(result.showcases).toEqual([]);
  expect(JSON.stringify(result.document)).toBe(bytes);
});

test('one local producer is bounded while legacy references retain their original selected presentation', () => {
  const payload = localShowcase();
  const local = extension('local', payload, ZONE_SHOWCASE_BLOCK_DEFINITION, '2');
  const legacy = extension('legacy', { 'rv:module': ['hero'] });
  const shell: ZonePresentation = { ...DEFAULT_ZONE_PRESENTATION,
    modules: [{ ...payload['rv:module'][0]!, title: 'Retained legacy hero' }],
    slides: [{ id: 'legacy-slide', href: '/legacy' }] };
  const result = resolveZonePageDocument(documentOf(legacy, local), shell, [], []);
  expect(result.showcases.find(showcase => showcase.id === 'hero')?.module?.title).toBe('Retained legacy hero');
  expect(result.showcaseData.slides).toBe(shell.slides);
  expect(result.showcases.find(showcase => showcase.id === 'block:local')?.slides).toEqual(payload['rv:slides']);
  expect(() => zoneDocumentShowcase(documentOf(local,
    extension('second', payload, ZONE_SHOWCASE_BLOCK_DEFINITION, '2')))).toThrow(WorkReadLimit);
});

test('site publish requires exact digest and Content owner epoch while retained receipt bindings remain minimal', () => {
  const retained = selection();
  const input = { ...retained, pages: retained.pages.map(saved => ({ ...saved,
    byteDigest: 'a'.repeat(64), contentEpoch: randomUUID() })) };
  expect(checkZoneSitePublishSelection(input)).toBe(input);
  expect(checkZoneSitePublication(retained)).toEqual(retained);
  expect(() => checkZoneSitePublishSelection(retained)).toThrow(InvalidZoneConfiguration);
  for (const invalid of [
    { ...input.pages[0], byteDigest: undefined },
    { ...input.pages[0], contentEpoch: undefined },
    { ...input.pages[0], byteDigest: 'a'.repeat(63) },
    { ...input.pages[0], byteDigest: 'A'.repeat(64) },
    { ...input.pages[0], contentEpoch: 'current' },
  ]) expect(() => checkZoneSitePublishSelection({ ...input, pages: [invalid] }))
    .toThrow(InvalidZoneConfiguration);
  expect(() => checkZoneSitePublishSelection({ ...input, pages: [input.pages[0], input.pages[0]] }))
    .toThrow(InvalidZoneConfiguration);
});

import { readZoneThemeExecution, ZONE_THEME_EXECUTION_COST } from '../src/modules/presentation/zone-theme.ts';
import { checkFirstPartyBundle } from '../src/modules/theme/first-party-bundle.ts';
import { ThemeUnavailable } from '../src/modules/theme/activation.ts';
import { RV } from '../src/modules/work/activate.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';

function zoneThemeFixture() {
  const zone = ref(), theme = ref(), approvedRevision = ref(), draftRevision = ref();
  const approvedActivation = ref(), newerActivation = ref();
  const submitter = ref(), reviewer = ref(), review = ref();
  const bundle = (name: string) => checkFirstPartyBundle({ profile: 'first-party-bundle-v1',
    hostZone: zone, entry: `assets/${name}.js`,
    files: [{ path: `assets/${name}.js`, digest: 'a'.repeat(64), gzipBytes: 1 }],
    slots: ['hero'], connectOrigins: [], imageOrigins: [], fontOrigins: [] });
  const approved = bundle('approved-a'), draft = bundle('draft-b');
  const live: Record<string, string> = { owner: submitter, host: zone,
    revision: draftRevision, digest: draft.dependencyDigest, bundle: JSON.stringify(draft.bundle),
    submitter, submitterPrincipal: 'principal-submitter', review,
    reviewer, reviewerPrincipal: 'principal-reviewer', decision: `${RV}Rejected`,
    evidence: 'b'.repeat(64), activation: approvedActivation, activationRevision: approvedRevision,
    expiry: '2099-01-01T00:00:00.000Z', activationControl: 'urn:rezics:theme:control:initial' };
  const proof: Record<string, string> = { digest: approved.dependencyDigest,
    bundle: JSON.stringify(approved.bundle), submitter, submitterPrincipal: 'principal-submitter',
    review, reviewer, reviewerPrincipal: 'principal-reviewer', decision: `${RV}Approved`,
    evidence: 'c'.repeat(64), expiry: '2099-01-01T00:00:00.000Z',
    activationControl: 'urn:rezics:theme:control:initial' };
  const queries: { text: string; bytes?: number }[] = [];
  let proofRows: Record<string, string>[] = [proof];
  const rows = (values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
    Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal', value: text }]))) } });
  const env = { lineage: { dataEpoch: randomUUID(), routingEpoch: '1' },
    fuseki: { async query(text: string, bytes?: number): Promise<SparqlResult> {
      queries.push({ text, bytes });
      if (text.includes('ASK {')) return { boolean: true };
      if (text.includes('SELECT ?owner ?host ?revision')) return rows([live]);
      if (text.includes('SELECT ?digest ?bundle ?submitter')) return rows(proofRows);
      throw new Error('Unexpected Zone theme query');
    } },
  } as WorkActivationEnvironment;
  return { env, zone, theme, approvedRevision, draftRevision, approvedActivation, newerActivation,
    approved, draft, live, proof, queries,
    selection: { revision: approvedRevision, activation: approvedActivation },
    replaceProofRows(value: Record<string, string>[]) { proofRows = value; } };
}

test('site theme publication selects the approved activation despite a newer rejected draft head', async () => {
  const fixture = zoneThemeFixture();
  const result = await readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone);
  expect(result.selection).toEqual(fixture.selection);
  expect(result.execution).toEqual({ state: 'active', package: fixture.approved.bundle,
    revision: fixture.approvedRevision, activation: fixture.approvedActivation });
  expect(result.execution).not.toEqual({ state: 'active', package: fixture.draft.bundle,
    revision: fixture.draftRevision, activation: fixture.approvedActivation });
  const exact = fixture.queries.find(query => query.text.includes('SELECT ?digest ?bundle ?submitter'))!;
  expect(exact.text).toContain(`<${fixture.approvedActivation}> a rv:FirstPartyThemeActivation`);
  expect(exact.text).toContain(`rv:revision <${fixture.approvedRevision}>`);
  expect(exact.text).toContain(`LIMIT ${ZONE_THEME_EXECUTION_COST.selectionRows}`);
  expect(exact.bytes).toBe(ZONE_THEME_EXECUTION_COST.selectionResponseBytes);
});

test('a published theme selection stays on exact activation A when the live activation moves to B', async () => {
  const fixture = zoneThemeFixture();
  fixture.live.activation = fixture.newerActivation;
  fixture.live.activationRevision = fixture.draftRevision;
  fixture.live.decision = `${RV}Approved`;
  const result = await readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone, fixture.selection);
  expect(result.selection).toEqual(fixture.selection);
  expect(result.execution).toEqual({ state: 'active', package: fixture.approved.bundle,
    revision: fixture.approvedRevision, activation: fixture.approvedActivation });
  const exact = fixture.queries.find(query => query.text.includes('SELECT ?digest ?bundle ?submitter'))!;
  expect(exact.text).toContain(`<${fixture.approvedActivation}> a rv:FirstPartyThemeActivation`);
  expect(exact.text).not.toContain(`<${fixture.newerActivation}> a rv:FirstPartyThemeActivation`);
});

test('live theme revocation, global disable and expiry refuse execution but retain the published selection', async () => {
  for (const reason of ['revoked', 'globally_disabled', 'expired'] as const) {
    const fixture = zoneThemeFixture();
    if (reason === 'revoked') fixture.proof.revocation = ref();
    if (reason === 'globally_disabled') {
      fixture.live.control = 'urn:rezics:theme:control:initial';
      fixture.live.disabled = 'true';
    }
    if (reason === 'expired') fixture.proof.expiry = '2000-01-01T00:00:00.000Z';
    const result = await readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone, fixture.selection);
    expect(result.execution).toEqual({ state: 'fallback', reason });
    expect(result.selection).toEqual(fixture.selection);
    const prospective = await readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone);
    expect(prospective.execution).toEqual({ state: 'fallback', reason });
    expect(prospective.selection).toBeNull();
  }
});

test('explicit absence of a published theme performs no live or exact proof query', async () => {
  const fixture = zoneThemeFixture();
  expect(await readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone, null)).toEqual({
    execution: { state: 'fallback', reason: 'none_approved' }, selection: null,
  });
  expect(fixture.queries).toHaveLength(0);
});

test('exact published theme proof rejects absence, ambiguity, incomplete identity and malformed custody', async () => {
  for (const invalid of ['absent', 'ambiguous', 'missing-reviewer', 'unknown-decision',
    'invalid-json', 'invalid-bundle', 'wrong-digest', 'wrong-host'] as const) {
    const fixture = zoneThemeFixture();
    if (invalid === 'absent') fixture.replaceProofRows([]);
    if (invalid === 'ambiguous') fixture.replaceProofRows([fixture.proof, fixture.proof]);
    if (invalid === 'missing-reviewer') delete fixture.proof.reviewerPrincipal;
    if (invalid === 'unknown-decision') fixture.proof.decision = `${RV}Unreviewed`;
    if (invalid === 'invalid-json') fixture.proof.bundle = '{';
    if (invalid === 'invalid-bundle') fixture.proof.bundle = JSON.stringify({ profile: 'first-party-bundle-v1' });
    if (invalid === 'wrong-digest') fixture.proof.digest = 'd'.repeat(64);
    if (invalid === 'wrong-host') {
      const foreign = checkFirstPartyBundle({ ...fixture.approved.bundle, hostZone: ref() });
      fixture.proof.bundle = JSON.stringify(foreign.bundle);
      fixture.proof.digest = foreign.dependencyDigest;
    }
    await expect(readZoneThemeExecution(fixture.env, fixture.theme, fixture.zone, fixture.selection))
      .rejects.toBeInstanceOf(ThemeUnavailable);
  }
});
