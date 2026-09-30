// Typed `entity-page-v1` projections for stories and tests. Shapes come from the Eden types, so a contract change
// breaks them as well as the page. The section table mirrors Main's (`modules/entity-page/read.ts`): a base binds
// its sections, and a Work's presentation adds its one type section.
import { typeEntry } from '../catalogue/types.ts';
import type { EntityProjection, SectionId, StatementItem, StatementPage, TargetBase } from './types.ts';

const iri = (uuid: string) => `https://rezics.com/id/${uuid}`;
const sourcePosition = { dataEpoch: '8c483e38-59e7-4d95-b27b-de9cd6742a3e', sequence: '4812' };

export const baseSections: Record<TargetBase, readonly SectionId[]> = {
  work: ['statements', 'releases', 'contents', 'relations', 'credits', 'ratings', 'reviews', 'discussion'],
  release: ['statements', 'relations', 'credits', 'ratings', 'reviews', 'discussion'],
  realization: ['statements', 'relations', 'discussion'],
  occurrence: ['statements', 'relations', 'discussion'],
  resource: ['statements', 'relations', 'discussion'],
};

const typeHref = { recipe: 'recipes', prompt: 'hub', skill: 'hub' } as const;

/** The projection Main serves for a resource of `base` typed `types`, named `name`; needs the seeded type registry. */
export function projectionFor({ id = '0b9e4d2a-6c1f-4e8b-a3d5-7f2c9e1b4a6d', base, types, name, restricted = false }: {
  id?: string; base: TargetBase; types: readonly string[]; name: string; restricted?: boolean;
}): EntityProjection {
  const registryBase = base === 'work' || base === 'resource' ? base : 'record';
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
    summary: { reference: iri(id), status: 'available', type: base === 'work' ? 'work' : 'resource', base, work: null,
      disclosure: restricted ? 'restricted' : 'public',
      name: { value: name, language: 'en', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: '3fa2c9d17b8e4a6f0c2d5e8b1a4f7c90',
        resourceType: base === 'work' ? 'work' : 'resource' } } as unknown as EntityProjection['summary'],
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
export const noStatements: StatementPage = { ...statements(), groups: [], count: { value: 0, kind: 'exact-page', total: null } };
