/** Pending API decisions for C17/C23/C24/C25/C29/C31, for review before implementation.
 * This is a required corpus shape, not evidence that these records have been imported.
 * Original source IDs are supplied by a retained command-built corpus, never invented here.
 * Registry enrollment and implementation are owned separately.
 */
export const informationMatrix = {
  state: 'pending',
  baselineProduct: '69eac3ceeaf885be70205a70248bc951e9d81cc9',
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
    continuation: 'after is opaque and exclusive; the returned next/nextCursor binds subject, parent, order, language and public selection. Page size may change within capacity without changing that selection. A changed binding returns 400; a stale public selection returns 409 {code:"read_basis_changed",restart:{href:<same selection without after>}}, never an empty page. A private-only mutation must not invalidate public cursors. Counts, if present, match the corpus visible-only sectionCounts oracle, including zeroes, exact Context and target; hidden members and drafts contribute nothing.',
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

/** Joint Source/native-owner proposal. The accepted information read contract
 * above stays accepted; none of these admission additions has Program disposition.
 * Source owns retained conversion/inventory verification, not native value policy.
 */
export const nativeInformationAdmission = {
  state: 'pending-program-disposition',
  current: {
    semantic: 'POST /v1/semantic/changes; GET /v1/semantic/resources/{id}[/revisions/{revision}]. A resource component owns exact properties, semantic head, model generation and its command receipt.',
    statement: 'POST /v1/statements; GET /v1/statements/{id}. A Statement owns subject/predicate/relationDefinition/value/applicability/interpretation/qualification and head. Recording, acceptance and support are separate commands and identities.',
    synopsis: 'POST /v1/works/{id}/fields/synopsis/control owns Work editorial synopsis, content/control/work bases and human/source control. Current value is a nonempty string of at most 8000 characters with no supplied-language member. Work localized metadata has tagged single-line bounded text; it cannot losslessly stand in for every synopsis.',
    attach: 'POST /v1/sources/field-supports, source-field-support-attachment-v1: target, slot, occurrence, context, sourceRecord, conversion, grain, sourceField, sourceOccurrence, sourcePointer, expectedHead, actingSubject; Idempotency-Key. Current verified adapters admit only work-metadata-v1#semantic-types, work-metadata-v1#scalar-value and bounded structure-occurrence-v1 paths. The proposed name adapter is not arbitrary semantic admission.',
    receipt: '201 {support: source-field-support-v1, replayed:false}; exact retry 200 replayed:true. Support includes support/supportIdentity, sourceRecord/conversion/mappingRevision, valueDigest/nativeRevision/graphReceipt/headGuarantee/outcome. GET /v1/sources/field-supports/{support}; POST /v1/sources/withdrawals with support/expectedSupport/reason. Current withdrawal nativeEffect is none.',
    refusal: '400 invalid_source_withdrawal for malformed/unsupported attachment; 409 source_support_changed for mismatched native value/head or changed key; 503 source_support_unavailable for unavailable mapped evidence; current Access, platform exposure, principal isolation and rights errors also apply.',
  },
  proposed: {
    request: 'Extend the existing attachment with native (owner, component, predicate, exact typed value, qualifiers, expected head, command receipt; Statement identity/meaning/acceptance where applicable) and retained (exact conversion inventory key, normalized DatasetRecord identity/digest/pointer/presence/language, ordered retained observation parts and resolved observation pointer/digests). Existing top-level target/slot/occurrence/context/head must agree. Source conversion inventory items expose their verified retained binding. See NativeSupportAttachment and NativeSynopsisRequest in catalogue-information-contract.ts.',
    verification: 'Semantic/Statement/editorial owners verify their exact current component, subject, field/property, value, qualifiers and actual acknowledged command receipt. Source verifies G-2769 conversion/inventory binding, original record identity and actual retained observation bytes, including part order and the normalized-to-observation mapping. Normalized, observation, source-value and typed-native digests have different meanings; equality is never assumed. Projection is neither admission nor support.',
    receipt: 'Extend source-field-support-v1 with native, retained, publicEvidence and attachment {profile:source-field-attachment-certificate-v1,receipt,requestDigest,nativeReceipt}; graphReceipt is the verified native command receipt. An actual Source command issues this acknowledgement; a producer cannot manufacture it. Native revision/receipt remain owned by the native command, and the support stays independently withdrawable per sourceRecord. Keep the actual headGuarantee, including verified-before-commit; claim no stronger cross-owner atomicity.',
    refusal: 'Reuse 409 source_support_changed for target/property/value/qualifiers/head/conversion/evidence-binding mismatches and changed idempotency intent; 503 source_support_unavailable for absent/incomplete retained bytes; 404 source_support_unavailable for another principal\'s evidence, without detail; 403 rights_denied for a scoped reuse denial. Proposed 400 invalid_source_attachment identifies an unadmitted native slot. Refusals return no support or receipt and leave native content unchanged.',
    language: 'Native synopsis retains exact text and supplied language, without trimming, truncation, NFC rewriting, newline flattening or UI-locale substitution. Omitted language, explicit null and supplied spelling remain separate in retained.language. Extend the existing editorial owner rather than placing Work description into an arbitrary semantic property. Oversized/unrepresentable values need a lossless owner disposition or explicit pending/source-only reason; no successful attachment is inferred.',
    attribution: 'Existing fact evidence gains public-safe attribution {sourceName,sourceUrl,licence} and language {state:omitted|null|value,value?}. Exact rightsBasis, source identity, source digest and locator remain. Source/rights owners resolve publicEvidence; an import/adoption grant never authorizes publication or private evidence disclosure.',
    lifecycle: 'Repeated attachment is idempotent. Two different records supply separately withdrawable supports, not a claim of independent providers. Withdrawing one support preserves another qualifying support, exact native values, acceptance and human content/control. Source attachment and withdrawal never mint or replace native content.',
    ownership: 'G-2769 specifies Source conversion/admission; this matrix specifies native verification and independent public reads. G-2781 only projects candidates, G-2778 alone wires the importer, and G-2791 alone prepares the genuine corpus. Separate implementation assignment and Program disposition are required.',
  },
} as const;

// These are source-backed test obligations, never generated successful examples.
// New proposed receipts are checked in test bodies, not required by corpus setup.
export const nativeReadCases = {
  'synopsis-tagged': { kind: 'synopsis', disposition: 'admitted', presence: 'value' },
  'synopsis-multiline': { kind: 'synopsis', disposition: 'admitted', presence: 'value' },
  'synopsis-untagged': { kind: 'synopsis', disposition: 'admitted', presence: 'value' },
  'synopsis-oversized': { kind: 'synopsis', disposition: 'lossless-or-explicit', presence: 'value' },
  'synopsis-omitted': { kind: 'synopsis', disposition: 'explicit', presence: 'omitted' },
  'synopsis-null': { kind: 'synopsis', disposition: 'explicit', presence: 'null' },
  'synopsis-empty': { kind: 'synopsis', disposition: 'lossless-or-explicit', presence: 'empty-string' },
  'exact-number': { kind: 'domain-fact', disposition: 'admitted', presence: 'value' },
  'date-precision': { kind: 'domain-fact', disposition: 'admitted', presence: 'value' },
  'domain-fact': { kind: 'domain-fact', disposition: 'admitted', presence: 'value' },
} as const;
export type NativeReadKey = keyof typeof nativeReadCases;

export const nativeAttachmentRefusals = {
  target: { status: 409, code: 'source_support_changed' },
  property: { status: 409, code: 'source_support_changed' },
  value: { status: 409, code: 'source_support_changed' },
  qualifiers: { status: 409, code: 'source_support_changed' },
  head: { status: 409, code: 'source_support_changed' },
  conversion: { status: 409, code: 'source_support_changed' },
  'native-receipt': { status: 409, code: 'source_support_changed' },
  'evidence-binding': { status: 409, code: 'source_support_changed' },
  'parts-order': { status: 409, code: 'source_support_changed' },
  'unavailable-evidence': { status: 503, code: 'source_support_unavailable' },
  'private-evidence': { status: 404, code: 'source_support_unavailable' },
  rights: { status: 403, code: 'rights_denied' },
  'unsupported-slot': { status: 400, code: 'invalid_source_attachment' },
} as const;
export type NativeRefusalKey = keyof typeof nativeAttachmentRefusals;
