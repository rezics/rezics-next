import { t } from 'elysia';
import { displayLanguageBasis } from '../display-language/schema.ts';
import { obligationKinds } from '../rights/schema.ts';
import type { PersonPreferencesStore } from '../preferences/store.ts';
import { authorNameProvenance } from '../source/author-name.ts';
import { coverCreditSchema } from '../media/cover-credit.ts';
import type { Viewer } from '../suitability/policy.ts';
import { catalogueNavigation } from '../query/navigation-contract.ts';
import { recordedText, recordedRelevance, serialStatus } from './metadata-schema.ts';

export const readId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
export const readUuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const readLanguage = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });
export const readPosition = t.Object({ dataEpoch: t.String(), sequence: t.String(),
  dependencyToken: t.Optional(t.String({ pattern: '^[0-9a-f]{64}$' })) });
export const readName = t.Object({ value: t.String(), language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: displayLanguageBasis });
/** Same unavailable summary alternative. The participant's reference stays on the parent item. */
export const withheldReadName = t.Object({ reference: readId, status: t.Literal('unavailable') },
  { additionalProperties: false });
/** A shown participant name, or the unavailable shape when only that name is withheld. */
export const participantReadName = t.Union([readName, withheldReadName]);

/** Work titles stay `readName`. A participant name uses the name policy: the identity remains,
 * and a withheld name is the unavailable shape rather than the private text. One preference read.
 * The policy module is loaded on call: this schema is imported while other schemas are still initializing. */
export async function discloseParticipantName<T extends { value: string }>(
  preferences: Pick<PersonPreferencesStore, 'visibleNameOwners'> | undefined,
  participant: string, name: T, viewer: Viewer,
): Promise<T | { reference: string; status: 'unavailable' }> {
  const { visibleNames } = await import('../disclosure/name-policy.ts');
  const visible = await visibleNames(preferences, [participant], viewer, 'read');
  return visible.has(participant) ? name : { reference: participant, status: 'unavailable' };
}
/** A tuple, so the response type keeps each kind. The record must match `obligationKinds`. */
const obligationKindLiteral = {
  attribution: t.Literal('attribution'), share_alike: t.Literal('share_alike'),
  notice_retention: t.Literal('notice_retention'), change_indication: t.Literal('change_indication'),
  non_commercial: t.Literal('non_commercial'), no_derivatives: t.Literal('no_derivatives'),
  other: t.Literal('other'),
} satisfies Record<typeof obligationKinds[number], ReturnType<typeof t.Literal>>;
const obligationKind = t.Union([
  obligationKindLiteral.attribution, obligationKindLiteral.share_alike,
  obligationKindLiteral.notice_retention, obligationKindLiteral.change_indication,
  obligationKindLiteral.non_commercial, obligationKindLiteral.no_derivatives,
  obligationKindLiteral.other,
]);
/** Current wiki-display obligations of one text or fact set. `unassessed` is also the hidden shape. */
export const wikiDisplayObligations = t.Union([
  t.Object({ status: t.Literal('unassessed') }, { additionalProperties: false }),
  t.Object({ status: t.Literal('assessed'), use: t.Literal('wiki_display'),
    instrument: t.Nullable(t.String()),
    identity: t.Optional(t.Object({ assessmentId: readUuid, materialId: readUuid,
      component: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }),
      sourceRecordId: t.Nullable(readUuid), wikiEvidenceId: t.Nullable(t.String()) },
    { additionalProperties: false })),
    obligations: t.Array(t.Object({ kind: obligationKind, instrument: t.String(),
      appliesTo: t.Union([t.Literal('display'), t.Literal('all')]), notice: t.Nullable(t.String()) },
    { additionalProperties: false }), { maxItems: 16 }) }, { additionalProperties: false }),
]);
export const readAvatar = t.Union([
  t.Object({ kind: t.Literal('fallback'), policy: t.String(), key: t.String(), resourceType: t.String() }),
  t.Object({ kind: t.Literal('image'), selection: t.String(), url: t.String(), mediaType: t.String(),
    width: t.Integer(), height: t.Integer(), crop: t.Nullable(t.String()), coverCredit: coverCreditSchema,
    basis: t.Object({ policy: t.String(), context: t.String() }) }),
]);
export const readQuery = { language: t.Optional(readLanguage), actingSubject: t.Optional(readId) };
export const pageQuery = { ...readQuery, limit: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: 2048 })) };
export const scopeQuery = { scope: t.Optional(t.Union([t.Literal('global'), t.Literal('realm'), t.Literal('mine')])),
  realm: t.Optional(readId) };
export const readScope = t.Object({ kind: t.Union([t.Literal('global'), t.Literal('realm'), t.Literal('mine')]),
  realm: t.Nullable(readId) });
export const workCard = t.Object({ id: readId, revision: readId, mainVersion: readId,
  factObligations: t.Optional(wikiDisplayObligations),
  verification: t.Optional(t.Union([t.Literal('unverified'), t.Literal('verified')])),
  title: readName, cover: readAvatar, types: t.Array(t.String(), { maxItems: 8 }),
  tagline: t.Nullable(readName),
  completionStatus: t.Nullable(serialStatus),
  chapterCount: t.Nullable(t.Integer({ minimum: 0 })),
  wordCount: t.Nullable(t.Integer({ minimum: 0 })),
  lastUpdatedAt: t.Nullable(t.String({ format: 'date-time' })) });
export const workHeader = t.Object({ rights: t.Optional(t.Object({ basis: t.Literal('public-domain'),
  source: { ...t.Union([t.Object({ record: readId, observation: readId, provider: t.String(), externalId: t.String(),
    url: t.String(), license: t.Nullable(t.String()), author: t.Nullable(t.String()), transcriber: readId }),
  t.Object({ kind: t.Literal('manual-citation'), rightsAssessmentId: t.String({ format: 'uuid' }),
    url: t.String(), license: t.Nullable(t.String()), author: t.Nullable(t.String()), transcriber: readId })]),
    required: ['url', 'license', 'author', 'transcriber'] } })), profile: t.Literal('work-read-v1'), ...workCard.properties,
  fieldProvenance: t.Optional(t.Object({ basis: t.Literal('creation'), revision: readId,
    contributor: t.String(), admission: t.String(),
    candidateReceipt: t.String(), fields: t.Array(t.String()) })),
  disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]),
  /** Server-established status for the exact structured publication head.
   * It deliberately carries no private Structure or revision identifiers. */
  publicationState: t.Union([t.Literal('published'), t.Literal('unpublished')]),
  /** Compare-and-swap head for an admitted editor, including a withdrawn decision.
   * This reference conveys no publication authority or private Structure contents. */
  structurePublicationHead: t.Optional(t.Nullable(readId)),
  originalTitle: t.Nullable(t.Object({ ...recordedText.properties,
    direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]) })),
  metadataRevision: t.Nullable(readId), description: t.Nullable(readName),
  descriptionObligations: wikiDisplayObligations,
  mainVersionRevision: readId, mainVersionLabel: t.Nullable(readName),
  selectedLanguage: t.Nullable(t.String()),
  /** Present when the Work is a chapter: its Book, and where the chapter is read in the Book's contents. */
  sourcePosition: readPosition,
  navigation: t.Optional(catalogueNavigation),
  links: t.Object({ versions: t.String(), classifications: t.String(), adoptions: t.String(),
    ratings: t.String(), history: t.String(), credits: t.String(), metadata: t.String(), editions: t.String(),
    releases: t.Optional(t.String()), realizations: t.Optional(t.String()) }) });
export const pageFields = { nextCursor: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) };
export const versionItem = t.Object({ id: readId,
  kind: t.Union([t.Literal('text-variant'), t.Literal('release')]), language: t.String(),
  contribution: readId, revision: readId, selected: t.Boolean() });
export const adoptionItem = t.Object({ realm: readId, name: readName, selection: readId,
  contribution: readId, language: t.String() });
export { NATIVE_CREDIT_ROLES, WORK_CREDIT_ROLES, isNativeCreditRole, type NativeCreditRole, type WorkCreditRole } from './credit-roles.ts';
export const nativeCreditRole = t.Union([
  t.Literal('author'), t.Literal('translator'), t.Literal('editor'),
  t.Literal('director'), t.Literal('artist'), t.Literal('animation-studio'),
  t.Literal('performer'),
]);
export const workCreditRole = t.Union([
  t.Literal('author'), t.Literal('director'), t.Literal('artist'), t.Literal('animation-studio'), t.Literal('translator'), t.Literal('editor'), t.Literal('transcriber'), t.Literal('performer'),
]);
export const externalCreditParticipant = t.Object({ kind: t.Literal('external-reference'),
  provider: t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }), namespace: t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  key: t.String({ minLength: 1, maxLength: 200, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }) }, { additionalProperties: false });
const creditName = {
  displayName: t.Nullable(t.String({ minLength: 1, maxLength: 200 })),
  handle: t.Null(),
  nameSource: t.Optional(authorNameProvenance),
  confirmation: t.Optional(t.Literal('source-reported')),
};
export const creditItem = t.Union([
  t.Object({
    id: readId, role: workCreditRole,
    participantKind: t.Literal('external-reference'), provider: t.String(), namespace: t.Optional(t.String()),
    key: t.String(), ordinal: t.Integer(), agent: t.Null(), ...creditName,
  }),
  t.Object({
    id: readId, role: workCreditRole,
    participantKind: t.Literal('agent'), provider: t.Null(),
    key: t.Null(), ordinal: t.Null(), agent: readId, ...creditName,
  }),
]);
export const classificationItem = t.Object({ sense: readId, concept: readId, name: readName,
  relevanceRevision: t.Nullable(readId),
  relevanceStatus: t.Union([t.Literal('unrecorded'), t.Literal('recorded'), t.Literal('stale'), t.Literal('withdrawn')]),
  relevance: t.Nullable(recordedRelevance), source: t.Union([t.Literal('local'), t.Literal('global')]),
  decision: t.String() });
export const ratingRead = t.Object({ profile: t.Literal('work-rating-read-v1'), work: readId,
  mainVersion: readId, scope: readScope, context: t.Nullable(readId),
  status: t.Union([t.Literal('available'), t.Literal('no-context')]),
  aggregationScope: t.Nullable(t.Object({ question: t.String({ minLength: 3, maxLength: 120 }),
    grain: t.Literal('main-version'), population: t.Union([t.Literal('account-principal'),
      t.Literal('global-account-principal'), t.Literal('reader-account-principal')]), countedTarget: readId })),
  scale: t.Nullable(t.Object({ min: t.Number(), max: t.Number(), step: t.Number() })),
  count: t.Integer({ minimum: 0 }), mean: t.Nullable(t.Number()),
  distribution: t.Array(t.Object({ value: t.Number(), count: t.Integer({ minimum: 0 }) }), { maxItems: 1001 }),
  sourcePosition: readPosition });

/** Logical ceilings, not a claim about native Jena query-plan complexity. */
export const WORK_READ_COST = { pageSize: 20, graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  queryBytes: 512 * 1024, deadlineMs: 10_000, rootRows: 128, creditProbeRows: 129, attempts: 6,
  retryDelayMs: 25, maximumRetryDelayMs: 200 } as const;
