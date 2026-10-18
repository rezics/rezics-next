/** Pending API decisions for C17/C23/C24/C25/C29/C31, for review before implementation.
 * This is a required corpus shape, not evidence that these records have been imported.
 * Original source IDs are supplied by a retained command-built corpus, never invented here.
 * Registry enrollment and implementation are owned separately.
 */
export const informationMatrix = {
  state: 'pending',
  baselineProduct: '79be80d4d0e1cad1639b6a65e8f0795d6a95929a',
  preparationLimitMs: 600_000,
  sourceFixture: {
    path: '.temp/fixtures/catalogue-information/corpus.json',
    environment: 'REZICS_INFORMATION_CORPUS',
    requirement: 'One stopped all-owner backup, command receipts, exact original import identities, frozen bytes and scoped rights assessments; restore a pristine isolated copy for each prove file. The cursor file mutates its disposable copy and must not share live owner state with another file.',
    missing: 'The staged references contain specifications only. A retained rich supporting-entity/MusicBrainz corpus and its command builder are not supplied.',
  },
  reads: {
    page: '/v1/resources/{id}/page',
    facts: '/v1/resources/{id}/statements?limit=2[&after={cursor}]',
    inverse: '/v1/resources/{id}/relations?limit=1[&after={cursor}]',
    parts: '/v1/resources/{id}/parts?limit=1[&parent={occurrence}][&after={cursor}]',
    collection: '/v1/collections/{id}?limit=1[&after={cursor}]',
  },
  decisions: {
    binding: 'All admitted types use the same resource reads and model/lexicon bindings. No provider/domain parameter, backend switch or second authority mechanism.',
    facts: 'Retain subject-statements-v1. Each group adds display {label:{value,language},order}, coverage {state,sources,retry}; items retain exact values, qualifiers, sources and wiki evidence. Statements keep their identity and acceptance; component-properties keep their owner revision without fabricated Statement IDs or acceptance. Display order is model group rank, then source order, then stable identity; the cursor binds this order, subject, public selection, language and context.',
    attribution: 'Existing wiki evidence retains id/sourceWork/representationSha256/locator/rightsBasis/quoteWithheld. Each selected field/edge is compared with the exact frozen JSON pointer. Public evidence is projected once by identity; raw private bytes/quotes and inaccessible evidence paths are absent.',
    inverse: 'resource-relations-v1 retains rendering.meaning.definition, rendering.viewingRole and role-bound participants. Each entry adds applicability: string[] for its exact Context selection; counterparts retain their actual base. Both directions retain the same occurrence, revision and citations.',
    unknown: 'source-empty, acquisition-failed, unmapped, pending-adoption, adopted, unknown and rights-restricted are coverage states, not inferred from [] or null. some-value, no-value, empty literal, zero, null language and successful empty inventory retain different meanings.',
    partial: 'A successful identity resolve survives independent summary/name/fact failures. The page keeps target.resource/base/types/revision, its registry and successful section links; summary may be unavailable, with retry-after on the partial 200 page. A failed section stays HTTP 503 with bounded retry-after, never 200 null/[] or 404. Removing the injected storage fault and following the same href recovers the same object.',
    collection: 'Collection incidence adds collectionPurpose: null or {kind,statement,revision,sources}. Kinds are reading-list, recipe-selection, series, franchise. Only an adopted explicit purpose assertion sets it; generic membership and a title mentioning series cannot. The existing lexicon rendering supplies a neutral or purpose-qualified heading.',
    parts: 'Retain the shared Structure page, occurrence identity, parent, segmentKey and orderKey. Parts add target {resource,base,types} for any admitted target, and sourceOrder {position,label,source}. Work compatibility fields remain owner-defined. A medium is a container occurrence, a track is a use of a recording, and a recording is not a composition. Repeated targets keep distinct occurrences.',
    continuation: 'after is opaque and exclusive; the returned next/nextCursor binds subject, parent, order, language and public selection. Page size may change within capacity without changing that selection. A changed binding returns 400; a stale public selection returns 409 {code:"read_basis_changed",restart:{href:<same selection without after>}}, never an empty page. A private-only mutation must not invalidate public cursors. Counts, if present, describe visible results only.',
    authority: 'Imported Person/Organization are descriptive resources, never provisioned Agents. PublicationEvent is descriptive, never a selectable native Release. Authentication, membership, moderation and platform roles do not broaden these public reads. Use existing Access and rights owners.',
  },
  personas: {
    visitor: 'anonymous public reader',
    stranger: 'signed-in unrelated Person',
    member: 'member of the retained Realm, public selection unchanged',
    owner: 'actual importing/Collection-owning Person, private management remains separate',
    moderator: 'moderator of the retained Realm, ordinary public selection',
    operator: 'retained platform administrator, ordinary public selection',
  },
} as const;

// Semantic fields, not a provider-specific API. A source lacking a field records its
// coverage state; positive alias/description/date/zero/empty cases are mandatory below.
export const supportingRecords = {
  character: { provider: 'vndb', type: 'https://rezics.com/vocab/Character', base: 'resource',
    fields: ['name', 'aliases', 'description', 'birth-date', 'character-fact'] },
  person: { provider: 'vndb', type: 'https://schema.org/Person', base: 'resource',
    fields: ['name', 'aliases', 'description', 'person-fact'] },
  organization: { provider: 'vndb', type: 'https://schema.org/Organization', base: 'resource',
    fields: ['name', 'aliases', 'description', 'country'] },
  concept: { provider: 'vndb', type: 'https://schema.org/DefinedTerm', base: 'resource',
    fields: ['name', 'aliases', 'description', 'broader-term'] },
  publicationEvent: { provider: 'vndb', type: 'https://schema.org/PublicationEvent', base: 'resource',
    fields: ['name', 'release-date', 'language', 'platform'] },
  dataset: { provider: 'source', type: 'http://www.w3.org/ns/dcat#Dataset', base: 'resource',
    fields: ['name', 'identifier', 'license'] },
  episode: { provider: 'bangumi', type: 'https://schema.org/TVEpisode', base: 'resource',
    fields: ['name', 'air-date', 'episode-number', 'duration'] },
  artist: { provider: 'musicbrainz', type: 'https://schema.org/Person', base: 'resource',
    fields: ['name', 'aliases', 'begin-date', 'area'] },
  recording: { provider: 'musicbrainz', type: 'https://schema.org/MusicRecording', base: 'work',
    fields: ['name', 'length', 'isrc', 'disambiguation'] },
  composition: { provider: 'musicbrainz', type: 'https://schema.org/MusicComposition', base: 'resource',
    fields: ['name', 'iswc', 'language'] },
  label: { provider: 'musicbrainz', type: 'https://schema.org/Organization', base: 'resource',
    fields: ['name', 'aliases', 'begin-date', 'label-code'] },
  nativeRelease: { provider: 'native', type: 'https://rezics.com/vocab/Release', base: 'release',
    fields: ['name', 'release-date'] },
  book: { provider: 'native', type: 'https://schema.org/Book', base: 'work',
    fields: ['name', 'author'] },
  recipe: { provider: 'native', type: 'https://schema.org/Recipe', base: 'work',
    fields: ['name', 'servings'] },
} as const;
export type SupportingKey = keyof typeof supportingRecords;

export const fieldStates = [
  'source-empty', 'acquisition-failed', 'unmapped', 'pending-adoption',
  'adopted', 'unknown', 'rights-restricted',
] as const;
export type FieldState = typeof fieldStates[number];

export const collectionCases = {
  ordinary: { kind: null, heading: 'Collections' },
  bookList: { kind: 'reading-list', heading: 'Reading lists' },
  recipes: { kind: 'recipe-selection', heading: 'Recipe selections' },
  series: { kind: 'series', heading: 'Series' },
  franchise: { kind: 'franchise', heading: 'Franchises' },
} as const;
export type CollectionKey = keyof typeof collectionCases;

export const orderCases = ['episodes', 'media', 'tracks'] as const;
export type OrderKey = typeof orderCases[number];
