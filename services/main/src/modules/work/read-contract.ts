import { t } from 'elysia';
import { authorNameProvenance } from '../source/author-name.ts';
import { recordedText, recordedRelevance } from './metadata-schema.ts';

export const readId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
export const readUuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const readLanguage = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });
export const readPosition = t.Object({ dataEpoch: t.String(), sequence: t.String() });
export const readName = t.Object({ value: t.String(), language: t.String(),
  direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]),
  basis: t.Union([t.Literal('requested'), t.Literal('fallback')]) });
export const readAvatar = t.Union([
  t.Object({ kind: t.Literal('fallback'), policy: t.String(), key: t.String(), resourceType: t.String() }),
  t.Object({ kind: t.Literal('image'), selection: t.String(), url: t.String(), mediaType: t.String(),
    width: t.Integer(), height: t.Integer(), crop: t.Nullable(t.String()),
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
  title: readName, cover: readAvatar, types: t.Array(t.String(), { maxItems: 8 }),
  tagline: t.Nullable(readName),
  completionStatus: t.Nullable(t.Union([t.Literal('ongoing'), t.Literal('completed'), t.Literal('hiatus')])),
  chapterCount: t.Nullable(t.Integer({ minimum: 0 })),
  wordCount: t.Nullable(t.Integer({ minimum: 0 })),
  lastUpdatedAt: t.Nullable(t.String({ format: 'date-time' })) });
export const workHeader = t.Object({ profile: t.Literal('work-read-v1'), ...workCard.properties,
  disclosure: t.Union([t.Literal('public'), t.Literal('restricted')]),
  originalTitle: t.Nullable(t.Object({ ...recordedText.properties,
    direction: t.Union([t.Literal('ltr'), t.Literal('rtl')]) })),
  metadataRevision: t.Nullable(readId), description: t.Nullable(readName),
  mainVersionRevision: readId, mainVersionLabel: t.Nullable(readName),
  selectedLanguage: t.Nullable(t.String()), sourcePosition: readPosition,
  links: t.Object({ versions: t.String(), classifications: t.String(), adoptions: t.String(),
    ratings: t.String(), history: t.String(), credits: t.String(), metadata: t.String(), editions: t.String() }) });
export const pageFields = { nextCursor: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Literal('exact-page'), total: t.Null() }) };
export const versionItem = t.Object({ id: readId,
  kind: t.Union([t.Literal('text-variant'), t.Literal('release')]), language: t.String(),
  contribution: readId, revision: readId, selected: t.Boolean() });
export const adoptionItem = t.Object({ realm: readId, name: readName, selection: readId,
  contribution: readId, language: t.String() });
export const creditItem = t.Object({ id: readId, role: t.Literal('author'),
  participantKind: t.Literal('external-reference'), provider: t.Literal('open-library'),
  key: t.String(), ordinal: t.Integer(), agent: t.Null(),
  displayName: t.Nullable(t.String({ minLength: 1, maxLength: 200 })), handle: t.Null(),
  nameSource: t.Optional(authorNameProvenance),
  confirmation: t.Optional(t.Literal('source-reported')) });
export const classificationItem = t.Object({ sense: readId, concept: readId, name: readName,
  relevanceRevision: t.Nullable(readId),
  relevanceStatus: t.Union([t.Literal('unrecorded'), t.Literal('recorded'), t.Literal('stale'), t.Literal('withdrawn')]),
  relevance: t.Nullable(recordedRelevance), source: t.Union([t.Literal('local'), t.Literal('global')]),
  decision: t.String() });
export const ratingRead = t.Object({ profile: t.Literal('work-rating-read-v1'), work: readId,
  mainVersion: readId, scope: readScope, context: t.Nullable(readId),
  status: t.Union([t.Literal('available'), t.Literal('no-context')]),
  scale: t.Nullable(t.Object({ min: t.Integer(), max: t.Integer(), step: t.Literal(1) })),
  count: t.Integer({ minimum: 0 }), mean: t.Nullable(t.Number()),
  distribution: t.Array(t.Object({ value: t.Integer(), count: t.Integer({ minimum: 0 }) }), { maxItems: 10 }),
  sourcePosition: readPosition });

/** Logical ceilings, not a claim about native Jena query-plan complexity. */
export const WORK_READ_COST = { pageSize: 20, graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  queryBytes: 512 * 1024, deadlineMs: 10_000, rootRows: 128, creditProbeRows: 129, attempts: 6,
  retryDelayMs: 25, maximumRetryDelayMs: 200 } as const;
