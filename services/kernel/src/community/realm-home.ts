import { t } from 'elysia';
import type { KeyRing } from '../tokens/seal.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { AccessUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { mintReadTime, authoritativeTimeValue } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { accessCheck } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import type { ReadContext } from '../content/model.ts';
import {
  CommunityPresentationSchema,
  communityPresentationResponse,
  type CommunityPresentation,
} from '../content/community-presentation-model.ts';
import {
  createRealmHomeBoardObservationReader,
  RealmHomeBoardPageSchema,
  realmHomeBoardResponse,
  type RealmHomeBoardPage,
} from '../content/realm-board-home.ts';
import { readContainerBinding, revalidateContainerBinding } from './container-lifecycle.ts';
import { readRealm, type RealmDependencies, type RealmView } from './realm.ts';
import { readSpace, spaceReadEligibility, type Space } from './space.ts';
import { readRealmHomePresentation } from './realm-home-presentation.ts';
import { RealmSchema, SpaceSchema } from './schemas.ts';
import {
  createRealmHomePublicationObservationReader,
  RealmHomePublicationPageSchema,
  RealmHomePublicationQuerySchema,
  realmHomePublicationResponse,
  type RealmHomePublicationPage,
} from './realm-home-publications.ts';

export type RealmHomeDependencies = RealmDependencies & Readonly<{ tokens: KeyRing }>;
export type RealmHomeQuery = Readonly<{ languages?: readonly string[] }>;
// The presentation producer's join projection predates the viewer observation
// protocol. It cannot certify current standing or mounted command preconditions.
export type RealmHomePresentation = Omit<CommunityPresentation, 'join'>;
export type RealmHomeAdvice = 'sign-in' | 'unavailable';
export type RealmHomePage = Readonly<{
  realm: RealmView;
  space: Space;
  presentation: RealmHomePresentation;
  boards: RealmHomeBoardPage;
  publications: RealmHomePublicationPage;
  viewer: Readonly<{ state: 'anonymous' | 'unavailable' }>;
  actions: Readonly<Record<'participate' | 'join' | 'leave' | 'claim' | 'manage', RealmHomeAdvice>>;
}>;
const closed = { additionalProperties: false } as const;
const advice = t.Union([t.Literal('sign-in'), t.Literal('unavailable')]);
export const RealmHomeQuerySchema = t.Pick(RealmHomePublicationQuerySchema, ['languages'], closed);
export const RealmHomePresentationSchema = t.Omit(CommunityPresentationSchema, ['join'], closed);
export const RealmHomePageSchema = t.Object({
  realm: RealmSchema,
  space: SpaceSchema,
  presentation: RealmHomePresentationSchema,
  boards: RealmHomeBoardPageSchema,
  publications: RealmHomePublicationPageSchema,
  viewer: t.Object({ state: t.Union([t.Literal('anonymous'), t.Literal('unavailable')]) }, closed),
  actions: t.Object({ participate: advice, join: advice, leave: advice, claim: advice, manage: advice }, closed),
}, closed);

/** The native container witness binds identity/presentation and both shelves.
 * Fresh Realm and Space decisions run outside one another's preparation; the
 * final point read uses the original lifecycle/head binding, never public JSON.
 * This does not assert current membership, ban, leave-holder or action advice.
 */
async function observeContainer(deps: RealmHomeDependencies, realmId: string, context: ReadContext) {
  const realm = await readRealm(deps, context.actor, realmId, context);
  if (!realm) return null;
  const before = await withConnection(deps.pool, async (connection) => {
    const client = deadlineClient(connection, context.deadline);
    const at = await mintReadTime(client, deps.clock);
    return readContainerBinding(client, { realmId, at });
  });
  if (!before) return null;
  if (before.realmHead !== realm.headRevisionId || before.spaceId !== realm.spaceId)
    throw new AccessUnavailableError('contention');
  return {
    async current(): Promise<Readonly<{ realm: RealmView; space: Space }> | null> {
      requireAccessDeadline(context.deadline);
      const currentRealm = await readRealm(deps, context.actor, realmId, context);
      if (!currentRealm) return null;
      const identity = { route: routeOf(before.spaceId)!, id: before.spaceId };
      const check = await accessCheck(
        deps.access, context.actor, 'space:read',
        { ...identity, eligibility: spaceReadEligibility(identity) },
        { pool: deps.pool, deadline: context.deadline },
      );
      return withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, context.deadline);
        const at = await mintReadTime(client, deps.clock);
        if (!(await check(client, at))) return null;
        const space = await readSpace(client, before.spaceId, authoritativeTimeValue(at));
        if (!space) return null;
        if (currentRealm.headRevisionId !== before.realmHead || currentRealm.spaceId !== before.spaceId ||
            space.headRevisionId !== before.spaceHead || !(await revalidateContainerBinding(client, before, at)))
          throw new AccessUnavailableError('contention');
        return { realm: currentRealm, space };
      });
    },
  };
}

/** One initial page. Each shelf selects exactly once; the original observations
 * survive presentation hydration and are finalized before disclosure. Commands
 * keep their existing routes and reauthorize independently.
 */
export function createRealmHomeReader(deps: RealmHomeDependencies) {
  const boards = createRealmHomeBoardObservationReader(deps);
  const publications = createRealmHomePublicationObservationReader(deps);
  return async (realmId: string, context: ReadContext, query: RealmHomeQuery = {}): Promise<RealmHomePage | null> => {
    requireAccessDeadline(context.deadline);
    const container = await observeContainer(deps, realmId, context);
    if (!container) return null;
    const selectedBoards = await boards(realmId, context);
    const selectedPublications = await publications(realmId, context, query);
    if (!selectedPublications) return null;
    const presentation = await readRealmHomePresentation(deps, realmId, context);
    if (!presentation) throw new AccessUnavailableError('contention');
    if (!(await selectedBoards.current()) || !(await selectedPublications.current()))
      throw new AccessUnavailableError('contention');
    const identity = await container.current();
    if (!identity) return null;
    requireAccessDeadline(context.deadline);
    const { join: _join, ...currentPresentation } = presentation;
    const anonymous = context.actor.kind === 'anonymous';
    const action = anonymous ? 'sign-in' : 'unavailable';
    return {
      ...identity,
      presentation: currentPresentation,
      boards: selectedBoards.page,
      publications: selectedPublications.page,
      viewer: { state: anonymous ? 'anonymous' : 'unavailable' },
      actions: { participate: action, join: action, leave: action, claim: action, manage: action },
    };
  };
}

/** Publication continuation stays on its existing mounted reader. This board
 * continuation likewise preserves the original raw cursor and never reads the
 * sibling shelf or community presentation. */
export function createRealmHomeBoardReader(deps: RealmHomeDependencies) {
  const boards = createRealmHomeBoardObservationReader(deps);
  return async (realmId: string, context: ReadContext, query: { cursor?: string } = {}) => {
    requireAccessDeadline(context.deadline);
    const container = await observeContainer(deps, realmId, context);
    if (!container) return null;
    const selected = await boards(realmId, context, query);
    if (!(await selected.current())) throw new AccessUnavailableError('contention');
    if (!(await container.current())) return null;
    requireAccessDeadline(context.deadline);
    return selected.page;
  };
}

export function realmHomeResponse(page: RealmHomePage) {
  // Serialize through the same ordinary Realm/Space and native shelf models.
  // Join is deliberately absent from the presentation wire projection.
  const presentation = communityPresentationResponse({ ...page.presentation, join: { membership: 'unknown', action: null } });
  const { join: _join, ...withoutJoin } = presentation;
  return {
    realm: publishedRealm(page.realm),
    space: publishedSpace(page.space, page.realm.realmId),
    presentation: withoutJoin,
    boards: realmHomeBoardResponse(page.boards),
    publications: realmHomePublicationResponse(page.publications),
    viewer: page.viewer,
    actions: page.actions,
  };
}
export function publishedSpace(space: Space, realmId: string | null = null) {
  if (space.state !== 'active') throw new ProblemError('not_found');
  return {
    spaceId: space.spaceId,
    realmId,
    state: 'active' as const,
    headRevisionId: space.headRevisionId,
    createdAt: space.createdAt,
    creator: space.creator,
    predecessor: space.predecessor,
    address: space.address,
    title: space.title,
    summary: space.summary,
    revisionCreatedAt: space.revisionCreatedAt,
    author: space.author,
  };
}

export function publishedRealm(value: RealmView) {
  if (value.state !== 'active') throw new ProblemError('not_found');
  return {
    realmId: value.realmId,
    spaceId: value.spaceId,
    state: 'active' as const,
    visibility: value.visibility as 'public' | 'protected',
    contextId: value.contextId,
    boardSchemeId: value.boardSchemeId,
    ownershipState: value.ownershipState,
    orphanedAt: value.orphanedAt,
    claimEligibleAt: value.claimEligibleAt,
    governanceReadOnly: value.governanceReadOnly,
    headRevisionId: value.headRevisionId,
    createdAt: value.createdAt,
    creator: value.creator,
    predecessor: value.predecessor,
    title: value.title,
    summary: value.summary,
    revisionCreatedAt: value.revisionCreatedAt,
    author: value.author,
    votes: value.votes,
    presentation: value.presentation,
  };
}

