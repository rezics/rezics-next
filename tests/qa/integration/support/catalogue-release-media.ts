import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { requireQa } from '../recommendation-support.ts';
import { assertAuditExecution } from '../../support/audit-execution.ts';
import { restorePersonaRealms, type PersonaSession, type PersonaSessions,
  type RetainedPersonaRealm } from '../../support/personas.ts';

// This is an expectation manifest for an already restored command-created corpus,
// never a substitute for product answers or a permission to capture/import live data.
export const releaseMediaFixturePath = '.temp/qa-fixtures/catalogue/releases-and-media.json';
export const releaseMediaSelection = 'catalogue-release-media';
export const preparationBudgetMs = 600_000;

export interface RetainedBytes { path: string; sha256: string; byteLength: number }
export interface SourceReference {
  provider: string; namespace: string; externalId: string; sourceRevision: string | null;
  datasetSnapshotDigest: string; recordDigest: string; fieldLocator: string;
  record: string; observation: string; href: string;
}
export interface FieldEvidence {
  source: SourceReference;
  /** Exact JSON Pointer and value in the retained source record, before normalization. */
  recordBytes: RetainedBytes; pointer: string; presence: 'present' | 'absent'; value: unknown;
  disposition: 'adopted' | 'rejected' | 'unsupported' | 'unknown';
  /** Pointer into this SourceCatalogue; null means no native claim was adopted. */
  nativePointer: string | null; normalizedValue: unknown;
}
export interface RealizationExpectation {
  id: string; revision: string; language: string; translators: string[];
  kind: 'original' | 'translation'; status: 'official' | 'unofficial'; evidence: string;
  sourceEvidence: SourceReference[];
}
export interface ReleaseExpectation {
  id: string; revision: string; status: 'official' | 'unofficial' | 'withdrawn' | 'cancelled';
  platform: string | null; publicationYear: number | null; territory: string | null;
  identifiers: Array<{ provider: string; value: string }>;
  coverage: Array<{ work: string; mainVersion: string; realization: string; revision: string;
    language: string; completeness: 'complete' | 'partial' | 'trial' | 'unknown' }>;
  sourceEvidence: SourceReference[];
}
export interface ReleaseSelection {
  language: string; platform: string; status: 'official' | 'unofficial';
  completeness: 'complete' | 'partial' | 'trial'; translator: string;
}
export interface SourceCatalogue {
  provider: string; work: string; mainVersion: string;
  releases: ReleaseExpectation[]; realizations: RealizationExpectation[];
  fields: FieldEvidence[];
  /** A positive retained release and a negative conjunction use the same generic query. */
  selection: ReleaseSelection; matchingReleases: string[];
  counterexamples: Array<{ kind: 'cross-release' | 'cross-coverage' | 'wrong-translator' | 'publication-event';
    selection: ReleaseSelection; forbiddenReleases: string[]; descriptiveEvent?: string }>;
}
export interface ImageFacts {
  resource: string; role: 'cover' | 'portrait'; source: SourceReference;
  sourceRecord: RetainedBytes; sourcePointer: string; originalUrl: string;
  /** Real retained source image. A generated solid image is not this fixture. */
  original: RetainedBytes; originalDimensions: { width: number; height: number };
  mediaType: string; width: number; height: number; crop: string | null;
  credit: { kind: 'copyright'; text: string; holder: string | null;
    source: { name: string; href: string }; permittedRole: 'cover' | 'portrait' };
  rights: { basis: string; license: string | null; evidence: string; obligations: string[] };
}
export type ImageExpectation = ImageFacts & (
  | { delivery: 'official-reference' }
  | { delivery: 'native-bytes'; representationBytes: RetainedBytes }
);
export interface MediaDisposition {
  resource: string; role: 'cover' | 'portrait'; source: SourceReference;
  reason: 'missing-evidence' | 'acquisition-failed' | 'publication-forbidden';
}
export interface ReadingExpectation {
  work: string; release: string; releaseRevision: string; language: string;
  realization: string; realizationRevision: string;
  structure: string; occurrence: string; chapter: string; contentRevision: string;
  position: string;
}
export interface ReleaseMediaFixture {
  format: 'catalogue-release-media-v1'; selection: typeof releaseMediaSelection;
  /** Prepared once; a fresh isolated copy is bound to this QA run, not shared dev. */
  preparation: { command: string; buildMs: number; restoreMs: number; qaRunId: string;
    backupDigest: string; sourceKey: string; baselineProductRevision: string;
    sourceOwners: Record<string, string>; restoredOwners: Record<string, string> };
  personas: RetainedPersonaRealm;
  catalogues: SourceCatalogue[];
  images: ImageExpectation[];
  mediaDispositions: MediaDisposition[];
  /** All six ordinary reads lack grants to these controls, including the operator. */
  hidden: { work: string; release: string; releaseRevision: string; realization: string; portrait: string; marker: string;
    withdrawnRelease: string; withdrawnReleaseRevision: string; withdrawnImage: string; absentWork: string; absentRelease: string;
    privateMedia: { representation: string; use: string };
    withdrawnMedia: { representation: string; use: string };
    absentMedia: { representation: string; use: string } };
  reading: ReadingExpectation;
}

export interface ReleaseView extends ReleaseExpectation { profile: 'release-v2'; contentLanguages: string[] }
export interface RealizationView extends RealizationExpectation { profile: 'realization-v1'; work: string }
export interface Page<T> { items: T[]; nextCursor: string | null;
  count: { value: number; kind: string; total: number | null } }
export type NavigationOperation =
  | { kind: 'resource'; method: 'GET'; href: string; operationId: string; responseProfile: string | null }
  | { kind: 'query'; method: 'POST'; href: '/v1/query'; operationId: 'postV1Query';
    request: Record<string, unknown>; responseProfile: 'query-v1' };
export interface PageImage {
  kind: 'image'; selection: string; url: string; mediaType: string;
  width: number; height: number; crop: string | null;
  role: 'cover' | 'portrait'; sourceEvidence: SourceReference;
  coverCredit: ImageExpectation['credit']; rights: ImageExpectation['rights'];
}
export interface BusinessPage {
  profile: 'entity-page-v1';
  summary: { reference: string; avatar: PageImage | { kind: 'fallback' } };
  work: null | { id: string; cover: PageImage | { kind: 'fallback' } };
  sections: Array<{ id: string; href: string }>;
  navigation: Record<string, NavigationOperation>;
  mediaDispositions: MediaDisposition[];
}

export const shortId = (resource: string) => resource.slice(-36);
export const workPath = (resource: string) => `/v1/works/${shortId(resource)}`;
export const pagePath = (resource: string) => `/v1/resources/${shortId(resource)}/page`;
export const actorQuery = (person: PersonaSession) => `actingSubject=${encodeURIComponent(person.actingSubject!)}`;
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function retainedBytes(input: RetainedBytes): Buffer {
  const root = realpathSync(process.cwd());
  if (isAbsolute(input.path)) throw new Error('Retained evidence must be relative to this checkout');
  const path = realpathSync(resolve(root, input.path));
  if (relative(root, path).startsWith('..')) throw new Error('Retained evidence escapes this checkout');
  const bytes = readFileSync(path);
  expect(bytes.byteLength, input.path).toBe(input.byteLength);
  expect(digest(bytes), input.path).toBe(input.sha256);
  return bytes;
}

function pointer(document: unknown, path: string): unknown {
  if (!path.startsWith('/')) throw new Error(`Expected a source JSON Pointer: ${path}`);
  return path.slice(1).split('/').reduce<unknown>((value, part) => {
    if (value === null || typeof value !== 'object') throw new Error(`Source pointer is absent: ${path}`);
    return (value as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }, document);
}

function matchesSelection(catalogue: SourceCatalogue, release: ReleaseExpectation, selection: ReleaseSelection): boolean {
  return release.platform === selection.platform && release.status === selection.status
    && release.coverage.some(entry => entry.work === catalogue.work && entry.language === selection.language
      && entry.completeness === selection.completeness && catalogue.realizations.some(realization =>
        realization.id === entry.realization && realization.revision === entry.revision
        && realization.language === entry.language && realization.translators.includes(selection.translator)));
}

function checkCounterexamples(catalogue: SourceCatalogue): void {
  expect(catalogue.releases.filter(release => matchesSelection(catalogue, release, catalogue.selection))
    .map(release => release.id).sort()).toEqual([...catalogue.matchingReleases].sort());
  for (const example of catalogue.counterexamples) {
    expect(catalogue.releases.some(release => matchesSelection(catalogue, release, example.selection)), example.kind).toBe(false);
    expect(example.forbiddenReleases.length).toBeGreaterThan(0);
    const { selection } = example;
    const fieldsPresent = (releases: ReleaseExpectation[]) => [
      releases.some(release => release.platform === selection.platform),
      releases.some(release => release.status === selection.status),
      releases.some(release => release.coverage.some(entry => entry.language === selection.language)),
      releases.some(release => release.coverage.some(entry => entry.completeness === selection.completeness)),
      releases.some(release => release.coverage.some(entry => catalogue.realizations.some(realization =>
        realization.id === entry.realization && realization.revision === entry.revision
        && realization.translators.includes(selection.translator)))),
    ].every(Boolean);
    if (example.kind === 'cross-release') expect(fieldsPresent(catalogue.releases), 'split release witness must contain all requested facts').toBe(true);
    if (example.kind === 'cross-coverage' || example.kind === 'wrong-translator') expect(catalogue.releases.some(release =>
      release.platform === selection.platform && release.status === selection.status && fieldsPresent([release])),
    'one release has the facts on different coverage entries').toBe(true);
    if (example.kind === 'publication-event') {
      expect(example.descriptiveEvent).toBeTruthy();
      expect(catalogue.releases.map(release => release.id)).not.toContain(example.descriptiveEvent!);
    }
  }
}

export async function openReleaseMediaFixture(): Promise<{ fixture: ReleaseMediaFixture; sessions: PersonaSessions }> {
  const qaRunId = requireQa();
  if (!existsSync(releaseMediaFixturePath)) {
    throw new Error(`RELEASE_MEDIA_FIXTURE_REQUIRED: ${releaseMediaFixturePath}; prepare retained real VNDB and a second source, cover/portrait evidence, scoped command receipts and one consistent backup, then restore an isolated copy. No live acquisition or blank/synthetic substitute is allowed.`);
  }
  const fixture = JSON.parse(readFileSync(releaseMediaFixturePath, 'utf8')) as ReleaseMediaFixture;
  assertAuditExecution(fixture, { productBaseline: fixture.preparation.baselineProductRevision,
    fixtureGeneration: fixture.preparation.sourceKey });
  expect(fixture.format).toBe('catalogue-release-media-v1');
  expect(fixture.selection).toBe(releaseMediaSelection);
  expect(fixture.preparation.qaRunId).toBe(qaRunId);
  expect(fixture.preparation.baselineProductRevision).toMatch(/^[a-f0-9]{40}$/);
  expect(fixture.preparation.command).toContain('goalctl.ts test ');
  expect(fixture.preparation.sourceKey).toMatch(/^rs-/);
  expect(fixture.preparation.backupDigest).toMatch(/^[a-f0-9]{64}$/);
  for (const ms of [fixture.preparation.buildMs, fixture.preparation.restoreMs]) {
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(preparationBudgetMs);
  }
  // The restore producer must bind these locators to its verified owner cut.
  for (const owner of ['graph', 'account', 'access', 'content', 'relay', 'objects']) {
    expect(fixture.preparation.sourceOwners[owner]).toBeTruthy();
    expect(fixture.preparation.restoredOwners[owner]).toBeTruthy();
    expect(fixture.preparation.restoredOwners[owner]).not.toBe(fixture.preparation.sourceOwners[owner]);
  }
  expect(fixture.preparation.restoredOwners.graph).toBe(Bun.env.FUSEKI_URL!);
  expect(fixture.preparation.restoredOwners.account).toBe(Bun.env.ACCOUNT_DATABASE_URL!);
  expect(fixture.preparation.restoredOwners.access).toBe(Bun.env.ACCESS_DATABASE_URL!);
  expect(fixture.preparation.restoredOwners.content).toBe(Bun.env.CONTENT_DATABASE_URL!);
  expect(new Set(fixture.catalogues.map(catalogue => catalogue.provider)).size).toBeGreaterThanOrEqual(2);
  expect(fixture.catalogues.map(catalogue => catalogue.provider)).toContain('vndb');
  for (const catalogue of fixture.catalogues) {
    expect(catalogue.matchingReleases.length).toBeGreaterThan(0);
    expect(catalogue.releases.length).toBeGreaterThan(2); // Forces traversal with limit=2.
    expect(catalogue.releases.length).toBeLessThanOrEqual(6); // Room for both denied controls in the bounded group.
    expect(catalogue.counterexamples.map(example => example.kind)).toEqual(expect.arrayContaining([
      'cross-release', 'cross-coverage', 'wrong-translator', 'publication-event',
    ]));
    expect(catalogue.fields.length).toBeGreaterThan(0);
    for (const field of catalogue.fields) {
      const bytes = retainedBytes(field.recordBytes);
      expect(field.source.recordDigest).toBe(field.recordBytes.sha256);
      const raw = pointer(JSON.parse(bytes.toString()) as unknown, field.pointer);
      if (field.presence === 'absent') {
        expect(raw).toBeUndefined();
        expect(field.value).toBeNull();
        expect(field.disposition).toBe('unknown');
      } else expect(raw).toEqual(field.value);
      if (field.nativePointer !== null) {
        expect(field.disposition === 'adopted' || (field.disposition === 'unknown' && field.normalizedValue === null)).toBe(true);
        expect(pointer(catalogue, field.nativePointer)).toEqual(field.normalizedValue);
      }
    }
    for (const [index, release] of catalogue.releases.entries()) {
      expect(release.sourceEvidence.length).toBeGreaterThan(0);
      expect(release.identifiers).toContainEqual({ provider: catalogue.provider,
        value: release.sourceEvidence[0]!.externalId });
      for (const field of ['platform', 'status', 'publicationYear', 'territory', 'coverage', 'identifiers']) {
        expect(catalogue.fields.some(evidence => evidence.nativePointer === `/releases/${index}/${field}`),
          `retained source witness for release ${field}, including null/unknown`).toBe(true);
      }
    }
    for (const [index, realization] of catalogue.realizations.entries()) {
      expect(realization.sourceEvidence.length).toBeGreaterThan(0);
      for (const field of ['language', 'translators', 'status']) {
        expect(catalogue.fields.some(evidence => evidence.nativePointer === `/realizations/${index}/${field}`)).toBe(true);
      }
    }
    if (catalogue.provider === 'vndb') expect(catalogue.counterexamples.some(example =>
      example.selection.language === 'zh-Hans' && example.selection.platform === 'Windows'
      && example.selection.status === 'official' && example.selection.completeness === 'complete')).toBe(true);
    checkCounterexamples(catalogue);
  }
  for (const role of ['cover', 'portrait']) expect(fixture.images.some(image => image.role === role)).toBe(true);
  for (const role of ['cover', 'portrait']) expect(fixture.images.some(image => image.source.provider === 'vndb'
    && image.delivery === 'official-reference' && image.role === role)).toBe(true);
  expect(fixture.images.some(image => image.source.provider !== 'vndb' && image.role === 'cover')).toBe(true);
  for (const image of fixture.images) {
    retainedBytes(image.original);
    if (image.delivery === 'native-bytes') retainedBytes(image.representationBytes);
    const source = retainedBytes(image.sourceRecord);
    expect(image.source.recordDigest).toBe(image.sourceRecord.sha256);
    expect(pointer(JSON.parse(source.toString()) as unknown, image.sourcePointer)).toBe(image.originalUrl);
    expect(image.credit.permittedRole).toBe(image.role);
    expect(image.rights.evidence).toBeTruthy();
    expect(image.rights.obligations.length).toBeGreaterThan(0);
    expect(image.rights.basis).not.toBe('original-contribution');
  }
  expect(fixture.mediaDispositions.map(item => item.reason)).toEqual(expect.arrayContaining([
    'missing-evidence', 'acquisition-failed', 'publication-forbidden',
  ]));
  const reading = fixture.reading;
  const catalogue = fixture.catalogues.find(item => item.work === reading.work);
  expect(catalogue, 'saved choice must use an actual retained source Work').toBeDefined();
  const release = catalogue!.releases.find(item => item.id === reading.release && item.revision === reading.releaseRevision);
  expect(release).toBeDefined();
  expect(release!.coverage).toContainEqual(expect.objectContaining({ work: reading.work,
    realization: reading.realization, revision: reading.realizationRevision, language: reading.language }));
  expect(catalogue!.realizations).toContainEqual(expect.objectContaining({ id: reading.realization,
    revision: reading.realizationRevision, language: reading.language }));
  const [sessions] = await restorePersonaRealms([fixture.personas]);
  return { fixture, sessions: sessions! };
}

export async function jsonAnswer<T>(request: Promise<Response>, expectedStatus = 200): Promise<T> {
  const response = await request;
  const text = await response.text();
  expect(response.status, `${expectedStatus} expected; ${text.slice(0, 1500)}`).toBe(expectedStatus);
  return JSON.parse(text) as T;
}

export async function allPages<T extends { id: string }>(person: PersonaSession, path: string): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '2' });
    if (cursor) query.set('cursor', cursor);
    const page: Page<T> = await jsonAnswer(person.main('GET', `${path}?${query}`));
    expect(page.count).toEqual({ value: page.items.length, kind: 'exact-page', total: null });
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor) {
      expect(cursors.has(cursor), 'continuation must advance').toBe(false);
      cursors.add(cursor);
      expect(cursors.size, 'small retained corpus must finish').toBeLessThan(20);
    }
  } while (cursor);
  expect(new Set(items.map(item => item.id)).size).toBe(items.length);
  return items;
}

/** Existing release group; translator is a proposed exact-realization child facet. */
export function releaseQuery(releases: string[], selection: ReleaseSelection, cursor?: string) {
  return { context: 'global', scope: { kind: 'all' }, sort: 'newest', page: { size: 2, ...(cursor ? { continuation: cursor } : {}) },
    filter: { all: [{ facet: 'release', any: releases, where: { all: [
      { facet: 'releaseLanguage', any: [selection.language] },
      { facet: 'releasePlatform', any: [selection.platform] },
      { facet: 'releaseStatus', any: [selection.status] },
      { facet: 'releaseCompleteness', any: [selection.completeness] },
      { facet: 'releaseTranslator', any: [selection.translator] },
    ] } }] } };
}

export function assertNoHidden(value: unknown, fixture: ReleaseMediaFixture): void {
  const text = JSON.stringify(value);
  for (const secret of [fixture.hidden.work, fixture.hidden.release, fixture.hidden.realization,
    fixture.hidden.portrait, fixture.hidden.marker, fixture.hidden.withdrawnImage,
    fixture.hidden.privateMedia.representation, fixture.hidden.privateMedia.use,
    fixture.hidden.withdrawnMedia.representation, fixture.hidden.withdrawnMedia.use]) expect(text).not.toContain(secret);
}
