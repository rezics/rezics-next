// Typed `entity-page-v1` projections for stories and tests. Shapes come from the Eden types, so a contract change
// breaks them as well as the page. The section table mirrors Main's (`modules/entity-page/read.ts`): a base binds
// its sections, and a Work's presentation adds its one type section.
import { direction } from '@rezics/main/language';
import { uuidToSid } from '@rezics/model/address/sid';
import { typeEntry } from '../catalogue/types.ts';
import { summary } from '../work-levels/fixtures.ts';
import type { CreditedName } from '../work-levels/relation-rows.ts';
import type { AvailableSummary } from '../work-levels/types.ts';
import type { PredicateLabels } from './predicate-labels.ts';
import type { EntityProjection, RelationsPage, SectionId, StatementItem, StatementPage, TargetBase } from './types.ts';

const iri = (uuid: string) => `https://rezics.com/id/${uuid}`;
const sourcePosition = { dataEpoch: '8c483e38-59e7-4d95-b27b-de9cd6742a3e', sequence: '4812' };

export const baseSections: Record<TargetBase, readonly SectionId[]> = {
  work: ['statements', 'releases', 'contents', 'relations', 'credits', 'ratings', 'reviews', 'discussion'],
  release: ['statements', 'relations', 'credits', 'ratings', 'reviews', 'discussion'],
  realization: ['statements', 'relations', 'discussion'],
  occurrence: ['statements', 'relations', 'discussion'],
  resource: ['statements', 'relations', 'discussion'],
  projection: ['statements', 'relations', 'ratings', 'reviews', 'discussion'],
};

/** The `type` Main's summary gives each base: a Work, a release, a chapter occurrence, a text, or any other resource. */
const summaryType = { work: 'work', release: 'release', occurrence: 'occurrence', realization: 'realization',
  resource: 'resource', projection: 'projection' } as const satisfies Record<TargetBase, string>;

const typeHref = { recipe: 'recipes', prompt: 'hub', skill: 'hub' } as const;

/** The projection Main serves for a resource of `base` typed `types`, named `name`; needs the seeded type registry. */
export function projectionFor({ id = '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d', base, types, name, restricted = false }: {
  id?: string; base: TargetBase; types: readonly string[]; name: string; restricted?: boolean;
}): EntityProjection {
  const registryBase = base === 'work' || base === 'resource' || base === 'projection' ? base : 'record';
  const registry = typeEntry(types, registryBase);
  if (!registry) throw new Error('Seed the served type registry before building a projection');
  const typeSection = base === 'work' && (registry.presentation === 'recipe' || registry.presentation === 'prompt'
    || registry.presentation === 'skill') ? registry.presentation : null;
  const hrefOf = (section: SectionId) => base === 'work' && ['releases', 'contents', 'credits'].includes(section)
    ? `/v1/works/${id}/${section}` : `/v1/resources/${id}/${section}`;
  const sections = baseSections[base].map(section => ({ id: section, href: hrefOf(section), actions: [] as string[] }));
  if (typeSection) sections.splice(1, 0, { id: typeSection, href: `/v1/${typeHref[typeSection]}/works/${id}`, actions: [] });
  return {
    profile: 'entity-page-v1',
    target: { resource: iri(id), base, types: [...types], work: base === 'work' ? iri(id) : null,
      revision: iri('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c'), disclosure: restricted ? 'restricted' : 'public' },
    summary: { reference: iri(id), status: 'available', type: summaryType[base], base, work: base === 'work' ? iri(id) : null,
      disclosure: restricted ? 'restricted' : 'public', address: {
        ...(base === 'work' ? { prefix: '/w/' as const } : { prefix: '/e/' as const }),
        key: uuidToSid(id), suffixSource: restricted ? '' : name },
      name: { value: name, language: 'en', direction: direction('en', name), basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: '3fa2c9d17b8e4a6f0c2d5e8b1a4f7c90',
        resourceType: summaryType[base] } },
    registry, work: null, sections, sourcePosition,
  };
}

// Section pages, in Main's response shapes.
const position = { dataEpoch: sourcePosition.dataEpoch, sequence: sourcePosition.sequence };
const revision = (n: number) => iri(`a1b2c3d4-e5f6-4a7b-8c9d-${n.toString().padStart(12, '0')}`);
const qualifiers = { applicability: [], interpretationDefinitions: [] };
const acceptance = { context: 'urn:rezics:classification-context:global', decision: revision(90), source: 'global' as const };
const statement = (n: number, predicate: string, value: Extract<StatementItem, { kind: 'statement' }>['value']): StatementItem => ({
  kind: 'statement', statement: revision(n), revision: revision(n + 100), predicate, value, relationDefinition: revision(80),
  speaker: revision(81), meaningKey: `meaning-${n}`, qualifiers, sources: [], acceptance });

/** Statements of a character: a name in two scripts, a right-to-left epithet, an unknown value and a resource. */
export const statements = (next: string | null = null): StatementPage => ({
  profile: 'subject-statements-v1', resource: iri('0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d'),
  acceptanceContext: 'urn:rezics:classification-context:global',
  factObligations: { status: 'unassessed' },
  groups: [
    { predicate: 'https://schema.org/name', items: [
      statement(1, 'https://schema.org/name', { kind: 'literal', lexical: 'Kirito', datatype: 'rdf:langString', language: 'en' }),
      statement(2, 'https://schema.org/name', { kind: 'literal', lexical: 'キリト', datatype: 'rdf:langString', language: 'ja' })] },
    { predicate: 'https://schema.org/alternateName', items: [
      statement(3, 'https://schema.org/alternateName', { kind: 'literal', lexical: 'الشبح الأسود', datatype: 'rdf:langString', language: 'ar' })] },
    { predicate: 'https://schema.org/birthDate', items: [statement(4, 'https://schema.org/birthDate', { kind: 'some-value' })] },
    { predicate: 'https://schema.org/memberOf', items: [
      statement(5, 'https://schema.org/memberOf', { kind: 'resource', iri: iri('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a1c') })] },
  ],
  nextCursor: next, sourcePosition: position, count: { value: 5, kind: 'exact-page', total: null } });
/** A component's own property (a semantic resource's name), as the owner keeps it. */
export const componentStatements: StatementPage = { ...statements(), groups: [{ predicate: 'https://schema.org/name',
  items: [{ kind: 'component-property', revision: revision(7), predicate: 'https://schema.org/name', qualifiers, sources: [],
    value: { kind: 'language-string', lexical: 'معرض الهولوغرام', language: 'ar', direction: 'rtl' } }] }] };
export const noStatements: StatementPage = { ...statements(), groups: [], count: { value: 0, kind: 'exact-page', total: null } };

/** Imported source identity stays distinct from domain identifiers and source evidence can name an exact revision. */
export function importedSourceStatements(): StatementPage {
  const property = (n: number, predicate: string,
    value: Extract<StatementItem, { kind: 'component-property' }>['value']): StatementItem => ({
      kind: 'component-property', revision: revision(n), predicate, qualifiers, sources: [], value,
    });
  return { ...statements(), groups: [
    { predicate: 'https://schema.org/name', items: [property(1, 'https://schema.org/name',
      { kind: 'language-string', lexical: 'Example Studio', language: 'en', direction: direction('en', 'Example Studio') })] },
    { predicate: 'https://schema.org/identifier', items: [
      property(2, 'https://schema.org/identifier', { kind: 'external', provider: 'example', namespace: 'organization', key: 'studio-42' }),
      property(3, 'https://schema.org/identifier', { kind: 'string', lexical: 'Domain identifier 24' }),
    ] },
    { predicate: 'https://schema.org/url', items: [property(4, 'https://schema.org/url',
      { kind: 'string', lexical: 'https://example.test/organizations/studio-42' })] },
    { predicate: 'https://schema.org/foundingDate', items: [{ ...property(5, 'https://schema.org/foundingDate',
      { kind: 'string', lexical: '1997' }), sources: ['https://example.test/organizations/studio-42/revisions/3'] }] },
  ], count: { value: 5, kind: 'exact-page', total: null } };
}

/** Contract-shaped retained supports; production-owner coverage lives in Main's composed Source test. */
export function retainedSourceStatements(): StatementPage {
  const page = importedSourceStatements();
  const item = page.groups[3]!.items[0]!;
  if (item.kind !== 'component-property') throw new Error('Expected a component property');
  const record = revision(301);
  const citation: NonNullable<typeof item.citations>[number] = {
    kind: 'retained-source-field', id: revision(302), supportIdentity: revision(303), record, sourceWork: null,
    representationSha256: 'ab'.repeat(32), locator: { pointer: '/organization/founded' },
    attribution: { sourceName: 'Example Studio registry',
      sourceUrl: 'https://example.test/organizations/studio-42/revisions/3', licence: 'CC BY 4.0' },
    rightsBasis: { basisKind: 'license_offering', basisRef: null, licenseExpression: 'CC-BY-4.0',
      notice: 'Registry facts under CC BY 4.0', obligations: ['attribution'], useScope: 'quotation',
      result: 'supported', memberOrdinals: [0] },
    quote: 'Example Studio was founded in 1997.', quoteWithheld: false, language: { state: 'value', value: 'en' },
  };
  item.sources = [record];
  item.citations = [citation, { ...citation, id: revision(304), supportIdentity: revision(305),
    locator: { pointer: '/history/0/year' }, quote: null, quoteWithheld: true }];
  return page;
}

/** Distinct claims, their applicability, and a retained public evidence projection. Not a recorded API answer. */
export function citedStatements(withheld = false): StatementPage {
  const name = statement(21, 'https://schema.org/name',
    { kind: 'literal', lexical: 'Example Studio', datatype: 'rdf:langString', language: 'en' });
  const first = statement(22, 'https://schema.org/numberOfEmployees',
    { kind: 'literal', lexical: '24', datatype: 'http://www.w3.org/2001/XMLSchema#integer', language: null });
  const second = statement(23, first.predicate,
    { kind: 'literal', lexical: '31', datatype: 'http://www.w3.org/2001/XMLSchema#integer', language: null });
  if (first.kind !== 'statement') throw new Error('Expected a statement fixture');
  const evidence = revision(220);
  const digest = 'a3'.repeat(32);
  return { ...statements(), groups: [
    { predicate: name.predicate, items: [{ ...name, sources: ['https://example.test/studio/name'] }] },
    { predicate: first.predicate, items: [
      { ...first, qualifiers: { ...qualifiers, applicability: [revision(201)] }, sources: [evidence], evidence: [{
        id: evidence, sourceWork: revision(210), representationSha256: digest,
        locator: { version: 'rezics-locator-v1',
          source: { type: 'external', representationSha256: digest, mediaType: 'application/pdf' },
          selector: { type: 'ByteRangeSelector', unit: 'byte', start: 128, end: 256 },
          quote: withheld ? null : { type: 'TextQuoteSelector', exact: 'The studio employed 24 people in 1997.', prefix: '', suffix: '' } },
        quote: withheld ? null : 'The studio employed 24 people in 1997.', quoteWithheld: withheld,
        method: { type: 'manual', note: 'Checked against the annual report' }, modality: 'asserted',
        submitter: revision(211), rightsBasis: 'license',
      }] },
      { ...second, qualifiers: { ...qualifiers, applicability: [revision(202)] },
        sources: ['https://example.test/studio/annual-report/2001'] },
    ] },
    { predicate: 'https://schema.org/foundingDate', items: [statement(24, 'https://schema.org/foundingDate',
      { kind: 'literal', lexical: '1997', datatype: 'http://www.w3.org/2001/XMLSchema#gYear', language: null })] },
  ], count: { value: 4, kind: 'exact-page', total: null } };
}

export const citationNames = new Map([
  [revision(201), summary(revision(201), 'Annual report 1997')],
  [revision(202), summary(revision(202), 'Annual report 2001')],
]);

/** The labels Main selected for the statements' predicates; `memberOf` has none in the reader's language. */
export const predicateLabels: PredicateLabels = new Map(Object.entries({ name: 'Name', alternateName: 'Also known as', birthDate: 'Born' })
  .map(([term, value]) => [`https://schema.org/${term}`, { value, language: 'en', direction: direction('en', value) }]));

const appearanceProjection = (toRole: string, label: string, ref: string, creditedName?: CreditedName) => ({
  fromRole: 'subject', toRole, presentation: null,
  labels: { noun: label, heading: label, plurals: { other: label }, grammaticalForms: [] },
  language: 'en', script: 'Latn', direction: direction('en', label), reviewStatus: 'reviewed', source: null, licence: null, fallback: null,
  arguments: [{ role: 'subject', type: 'resource', value: { kind: 'resource', ref: iri('0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d') },
    ...creditedName ? { creditedName } : {} }, { role: toRole, type: 'resource', value: { kind: 'resource', ref } }] });

/** Where a character appears, as Main renders an occurrence of three roles seen from the character: the Work and its role apart. */
export function appearances(): RelationsPage {
  const subject = iri('0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d');
  const occurrence = (n: number, work: AvailableSummary, role: AvailableSummary, credited?: CreditedName) => ({
    relation: iri(`a1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0a0${n}`), kind: 'occurrence', revision: iri(`a1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0b0${n}`),
    evidence: null, sourceVersionStatus: 'exact',
    rendering: { profile: 'relation-rendering-v1', occurrence: null, viewingRole: 'subject',
      meaning: { definition: iri('a1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0c01'), revision: iri('a1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0c02'), lifecycle: 'active', roles: [] },
      bindings: [{ role: 'subject', participant: { kind: 'resource', ref: subject } },
        { role: 'role', participant: { kind: 'resource', ref: role.reference } },
        { role: 'work', participant: { kind: 'resource', ref: work.reference } }],
      projections: [appearanceProjection('role', 'Role', role.reference, credited),
        appearanceProjection('work', 'Appears in', work.reference)] },
    counterparts: [role, work] });
  const work = (id: string, name: string) => summary(iri(id), name, 'en', 'work') as AvailableSummary;
  const role = (id: string, name: string) => summary(iri(id), name, 'en', 'resource') as AvailableSummary;
  return { profile: 'resource-relations-v1', resource: subject, next: null, sourcePosition,
    items: [occurrence(1, work('b1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0001', 'A Certain Magical Index'),
      role('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0001', 'Supporting character'), { lexical: 'Mikoto', language: 'en' }),
    occurrence(2, work('b1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0002', 'A Certain Scientific Railgun'),
      role('c1e3a5f7-9b2d-4f6e-8c0a-2d4f6b8e0002', 'Lead character'))] } as unknown as RelationsPage;
}

/**
 * One appearance whose credited name Main withheld. The private words sit on the same value as the
 * unavailable reference, so a reader that still expects only a lexical name would show them.
 */
export function withheldCreditAppearance(): RelationsPage {
  const subject = iri('0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d');
  const page = appearances();
  const item = page.items[0]!;
  const roleProjection = item.rendering!.projections.find(projection => projection.toRole === 'role')!;
  roleProjection.labels = { noun: 'Translator', heading: 'Translator', plurals: { other: 'Translator' }, grammaticalForms: [] };
  const credit = roleProjection.arguments.find(argument => argument.role === 'subject')!;
  credit.creditedName = { lexical: 'Hidden Alias', language: 'en', reference: subject, status: 'unavailable' } as typeof credit.creditedName;
  const named = item.counterparts.find(summary => summary.status === 'available' && summary.name.value === 'Supporting character');
  if (named?.status === 'available') named.name = { ...named.name, value: 'Translator' };
  return { ...page, items: [item] };
}
