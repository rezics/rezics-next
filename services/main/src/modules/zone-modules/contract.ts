import { t } from 'elysia';
import { pageFields, readAvatar, readId, readName, readPosition, workCard }
  from '../work/read-contract.ts';
import { realmDecision } from '../realm-reads/read-contract.ts';
import { discoveryCredit } from '../discovery/contract.ts';

export const zoneModCard = t.Object({ profile: t.Literal('mod-work-card-v1'), game: t.Literal('Minecraft'),
  gameVersions: t.Array(t.String(), { maxItems: 1 }),
  loaders: t.Array(t.Union([t.Literal('Fabric'), t.Literal('Forge'), t.Literal('NeoForge')]),
    { maxItems: 1 }), latestRelease: t.Nullable(t.String()), capturedAt: t.String() });
export const zoneHubCard = t.Object({ profile: t.Literal('hub-work-card-v1'),
  kind: t.Union([t.Literal('prompt'), t.Literal('skill-package')]),
  declaredModels: t.Array(t.String(), { maxItems: 64 }), testedModels: t.Array(t.String(), { maxItems: 64 }),
  preview: t.String({ maxLength: 240 }), copyText: t.String({ maxLength: 65_536 }) });

export const ZONE_MODULE_COST = { pageSize: 20, candidateRows: 21, typeRows: 160, creditsPerWork: 3,
  serialHeads: 20, summaryBatches: 2, replyReviewChecks: 40, contentRevisions: 20,
  contentBytes: 20 * 1_048_576, creditQueries: 20, retainedAuthorKeys: 60,
  graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  deadlineMs: 10_000 } as const;

export const zoneWork = t.Object({ ...workCard.properties,
  primaryCredits: t.Array(discoveryCredit, { maxItems: ZONE_MODULE_COST.creditsPerWork }), evidence: readId,
  dataEpoch: t.String(), sequence: t.String(),
  mod: t.Nullable(zoneModCard), hub: t.Nullable(zoneHubCard) });
export const zoneWorkPage = t.Object({ profile: t.Union([
  t.Literal('zone-new-adoptions-v1'), t.Literal('zone-recently-completed-v1')]),
  realm: readId, items: t.Array(zoneWork, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneDecisionPage = t.Object({ profile: t.Literal('zone-recent-decisions-v1'), realm: readId,
  items: t.Array(realmDecision, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields,
  summary: t.Object({ adoption: t.Integer({ minimum: 0 }), classification: t.Integer({ minimum: 0 }),
    semanticRuleChange: t.Integer({ minimum: 0 }), basis: t.Literal('exact-page') }) });
export const zoneChapterPage = t.Object({ profile: t.Literal('zone-latest-chapters-v1'), realm: readId,
  items: t.Array(t.Object({ work: t.Object({ ...workCard.properties,
    primaryCredits: t.Array(discoveryCredit, { maxItems: ZONE_MODULE_COST.creditsPerWork }) }), chapter: readId, publication: readId,
    contentRevision: t.String(), language: t.String(), dataEpoch: t.String(), sequence: t.String() }),
  { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneReplyPage = t.Object({ profile: t.Union([
  t.Literal('zone-discussions-v1'), t.Literal('zone-reader-quotes-v1')]), realm: readId,
  items: t.Array(t.Object({ id: readId, placement: readId, author: readId, authorName: t.String(),
    work: t.Object({ id: readId, title: readName }),
    excerpt: t.String({ maxLength: 240 }), dataEpoch: t.String(), sequence: t.String() }),
  { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneGenrePage = t.Object({ profile: t.Literal('zone-genres-v1'),
  realm: readId, context: readId,
  items: t.Array(t.Object({ id: readId, concept: readId, name: readName }), { maxItems: ZONE_MODULE_COST.pageSize }),
  ...pageFields });
export const zoneEditorLists = t.Object({ profile: t.Literal('zone-editor-lists-v1'),
  realm: readId, lists: t.Array(t.Object({ collection: readId, name: readName,
    state: t.Union([t.Literal('complete'), t.Literal('partial')]),
    items: t.Array(t.Object({ id: readId, title: readName, cover: readAvatar }), { maxItems: 8 }) }),
  { maxItems: 2 }), sourcePosition: readPosition });
