import { t } from 'elysia';
import { readAvatar, readId, readName, readPosition, WORK_READ_COST } from '../work/read-contract.ts';
import { discoveryRating } from '../discovery/contract.ts';
import { AGENT_HANDLE_PATTERN } from '../agent/handle.ts';
import { VANITY_HANDLE_PATTERN } from '../agent/vanity.ts';

export const profileHandle = t.String({ pattern: `^(?:${AGENT_HANDLE_PATTERN.slice(1, -1)}|${VANITY_HANDLE_PATTERN.slice(1, -1)})$` });
export const agentRevision = t.String({ pattern:
  '^https://rezics\\.com/id/[0-9a-f-]{36}(?:-agent-revision)?$' });
export const creditRole = t.Union([t.Literal('author'), t.Literal('translator'), t.Literal('editor')]);
export const agentProfile = t.Object({ profile: t.Literal('agent-read-v1'), id: readId,
  displayName: t.String({ minLength: 1, maxLength: 200 }),
  revision: agentRevision,
  bio: t.Nullable(t.Object({ text: t.String({ minLength: 1, maxLength: 500 }),
    language: t.String({ minLength: 2, maxLength: 35 }) })),
  avatarSelection: t.Nullable(t.String()), avatarUrl: t.Nullable(t.String()),
  kind: t.Union([t.Literal('person'), t.Literal('organization'), t.Literal('service')]),
  handle: profileHandle, disclosure: t.Literal('public'), sourcePosition: readPosition,
  library: t.Object({ visibility: t.Union([t.Literal('public'), t.Literal('followers'), t.Literal('private')]),
    statusShelvesVisible: t.Boolean() }),
  links: t.Object({ profile: t.String(), works: t.String(), collections: t.String(),
    statusShelves: t.Optional(t.String()) }),
  resolution: t.Optional(t.Object({ requestedHandle: t.String(),
    state: t.Union([t.Literal('native'), t.Literal('current'), t.Literal('retired')]),
    redirect: t.Boolean(), canonical: t.String() })) });
export const shelfWork = t.Object({ id: readId, title: readName, cover: readAvatar });
export const creditedWork = t.Object({ ...shelfWork.properties,
  types: t.Array(t.String(), { maxItems: 8 }), tagline: t.Nullable(readName),
  completionStatus: t.Nullable(t.Union([t.Literal('ongoing'), t.Literal('completed'), t.Literal('hiatus')])),
  rating: t.Nullable(discoveryRating),
  attribution: t.Array(t.Object({ credit: readId, role: creditRole }), { maxItems: 3 }) });
export const shelfCollection = t.Object({ id: readId, revision: readId, name: t.String({ maxLength: 300 }),
  kind: t.Union([t.Literal('static'), t.Literal('captured')]), disclosure: t.Literal('public'),
  structure: readId });
export const libraryContribution = t.Object({ id: readId, work: t.Nullable(shelfWork),
  revision: readId, language: t.String(),
  publication: t.Union([t.Literal('draft'), t.Literal('public'), t.Literal('private')]) });
export const libraryRating = t.Object({ id: readId, revision: readId, work: t.Nullable(shelfWork),
  context: readId, mainVersion: readId, scope: t.Literal('global'),
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 5 })),
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]),
  scale: t.Object({ min: t.Literal(1), max: t.Literal(5), step: t.Literal(1) }) });

/** Shared metered graph envelope. Agent reads use 3 graph calls and one Media
 * avatar slot probe; collections
 * use 5; Work pages use ≤8 plus at most one serial batch, one type batch and
 * 20 bounded standing rating reads when a Context is selected. Library hydration
 * is O(P), P≤20, with two summary batches and final authority checks. SQL uses
 * five-second statements. Relation ordering may scan/sort D heads (O(D log D));
 * LIMIT bounds output, not native execution cost. No corpus-scale claim. */
export const PROFILE_READ_COST = { ...WORK_READ_COST, sqlStatementMs: 5_000,
  responseBytes: 512 * 1024, creditRoles: 3 } as const;
