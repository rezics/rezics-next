import type { ReadContext } from './model.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  ContentNotFoundError,
  readBookScopedPostMetadata,
  readPostMetadata,
  snapshot,
  type NativePostMetadata,
  type RetainContentRead,
} from './reads.ts';
import { hostedTargetKey } from './hosted-chapters-disclosure.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
import {
  observeIssuedRevisionDisclosure,
  revisionDisclosureReaderGate,
  revisionDisclosureSourceCurrent,
  revisionDisclosureStillIssued,
  type RevisionDisclosureMembership,
  type RevisionDisclosureSource,
} from './revision-disclosure.ts';

const anonymous = Object.freeze({ kind: 'anonymous' as const });

export type HostedPublicationAuthorityObservation = Readonly<{
  authorId: string;
  licence: string;
  homes: readonly number[];
}>;

export type HostedPointPublicEligibility = Readonly<{
  /** Recheck the original native observations. A false result is a private refusal. */
  final(): Promise<boolean>;
}>;

export type HostedPointDisclosureEligibility = Readonly<{
  /** Recheck public sources and exact private-source consent in the Book transaction. */
  final(client: AccessClient): Promise<boolean>;
}>;

function matches(value: NativePostMetadata | null, target: HostedChapterTarget): value is NativePostMetadata {
  return (
    value !== null &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256 &&
    value.visibility === 'published'
  );
}

/** Prepare an anonymous current-public read of one exact stored Post revision. */
async function preparePublicSource(
  deps: HostedDependencies,
  target: HostedChapterTarget,
  context: ReadContext,
  opening: boolean,
): Promise<HostedPointPublicEligibility | null> {
  const sourceRoute = routeOf(target.threadId);
  if (sourceRoute === null || routeOf(target.postId) !== sourceRoute || routeOf(target.revisionId) !== sourceRoute)
    return null;

  const expectedPartition = partitionOf(sourceRoute);
  const publicContext: ReadContext = { actor: anonymous, deadline: context.deadline };
  const retained: { current?: Parameters<RetainContentRead<NativePostMetadata>>[0] } = {};
  let initial: Awaited<ReturnType<typeof readPostMetadata>>;
  try {
    initial = await readPostMetadata(
      deps,
      target.threadId,
      target.postId,
      publicContext,
      target.revisionId,
      (current) => {
        retained.current = current;
      },
    );
  } catch (error) {
    if (error instanceof ContentNotFoundError) return null;
    throw error;
  }

  if (
    !matches(initial.value, target) ||
    (opening && initial.value.documentKind !== 'opening') ||
    !retained.current ||
    initial.anchor.partition.partitionNo !== expectedPartition
  )
    return null;

  const expectedEpoch = initial.anchor.epoch;
  const originalAuthor = initial.value.authorId;
  const originalLicence = initial.value.licence;
  const recheck = retained.current;
  return {
    async final() {
      try {
        const current = await recheck();
        return (
          matches(current.value, target) &&
          (!opening || current.value.documentKind === 'opening') &&
          current.value.authorId === originalAuthor &&
          current.value.licence === originalLicence &&
          current.anchor.partition.partitionNo === expectedPartition &&
          current.anchor.partition.partitionNo === initial.anchor.partition.partitionNo &&
          current.anchor.epoch === expectedEpoch
        );
      } catch (error) {
        if (error instanceof ContentNotFoundError) return false;
        throw error;
      }
    },
  };
}

/**
 * Prepare public eligibility independently of the private command admission.
 * The caller supplies only newly selected chapter targets; unchanged public
 * targets are intentionally outside this bounded proof. Metadata reads load no
 * revision bodies and retain the native anonymous Post, ancestry and Access
 * checks for a later recheck.
 */
export async function prepareHostedPointPublicEligibility(
  deps: HostedDependencies,
  catalogueOpening: HostedChapterTarget,
  newlySelectedTargets: readonly HostedChapterTarget[],
  context: ReadContext,
): Promise<HostedPointPublicEligibility | null> {
  const observations: HostedPointPublicEligibility[] = [];
  const seen = new Set<string>();
  const openingKey = hostedTargetKey(catalogueOpening);
  const opening = await preparePublicSource(deps, catalogueOpening, context, true);
  if (!opening) return null;
  observations.push(opening);
  seen.add(openingKey);

  for (const target of newlySelectedTargets) {
    const key = hostedTargetKey(target);
    if (seen.has(key)) continue;
    const observation = await preparePublicSource(deps, target, context, false);
    if (!observation) return null;
    observations.push(observation);
    seen.add(key);
  }

  return {
    async final() {
      for (const observation of observations) if (!(await observation.final())) return false;
      return true;
    },
  };
}

function disclosureSource(
  source: NonNullable<Awaited<ReturnType<typeof observeIssuedRevisionDisclosure>>>,
): RevisionDisclosureSource {
  return {
    ...source.target,
    licence: source.licence,
    creatorAccountId: source.issuerAccountId,
    incarnation: source.incarnation,
  };
}

function exactMetadata(value: NativePostMetadata | null, target: HostedChapterTarget): value is NativePostMetadata {
  return (
    value !== null &&
    value.id === target.postId &&
    value.threadId === target.threadId &&
    value.revisionId === target.revisionId &&
    value.sha256 === target.sha256
  );
}

function homeOf(id: string): number | null {
  const route = routeOf(id);
  return route === null ? null : partitionOf(route);
}

/**
 * Observe one exact target through current anonymous public eligibility or
 * exact catalogue consent. It reads metadata only, then records every native
 * home whose state can close the proof: source, account, Board, Realm and Space.
 * The caller must have captured its fixed home vector before calling this.
 */
export async function observeHostedPublicationActivationTarget(
  deps: HostedDependencies,
  input: Readonly<{
    catalogueId: string;
    activationRevisionId: string;
    target: HostedChapterTarget;
    occurrenceId: string;
    additionalAuthorityIds?: readonly string[];
    expectedAuthorId?: string;
    expectedLicence?: string;
    opening?: boolean;
  }>,
  context: ReadContext,
): Promise<HostedPublicationAuthorityObservation | null> {
  const route = routeOf(input.target.threadId);
  if (
    route === null ||
    routeOf(input.target.postId) !== route ||
    routeOf(input.target.revisionId) !== route ||
    routeOf(input.catalogueId) === null ||
    routeOf(input.activationRevisionId) !== routeOf(input.catalogueId) ||
    routeOf(input.occurrenceId) !== routeOf(input.catalogueId)
  )
    return null;

  const anonymousContext: ReadContext = { actor: anonymous, deadline: context.deadline };
  let metadata: NativePostMetadata | null = null;
  try {
    const current = await readPostMetadata(
      deps,
      input.target.threadId,
      input.target.postId,
      anonymousContext,
      input.target.revisionId,
    );
    if (exactMetadata(current.value, input.target) && current.value.visibility === 'published')
      metadata = current.value;
  } catch (error) {
    if (!(error instanceof ContentNotFoundError)) throw error;
  }

  if (!metadata) {
    const observation = await observeIssuedRevisionDisclosure(
      deps,
      { catalogueId: input.catalogueId, target: input.target },
      anonymousContext,
    );
    if (
      !observation ||
      observation.issuerAccountId !== (input.expectedAuthorId ?? observation.issuerAccountId) ||
      observation.licence !== (input.expectedLicence ?? observation.licence) ||
      observation.target.threadId !== input.target.threadId ||
      observation.target.postId !== input.target.postId ||
      observation.target.revisionId !== input.target.revisionId ||
      observation.target.sha256 !== input.target.sha256
    )
      return null;
    const membership: RevisionDisclosureMembership = {
      catalogueId: input.catalogueId,
      publicationId: input.activationRevisionId,
      occurrenceId: input.occurrenceId,
      sourceRevisionId: input.target.revisionId,
    };
    const gate = revisionDisclosureReaderGate(observation, membership);
    if (!gate) return null;
    try {
      const scoped = await readBookScopedPostMetadata(deps, input.catalogueId, input.target, gate, anonymousContext);
      if (!exactMetadata(scoped.value, input.target)) return null;
      metadata = scoped.value;
    } catch (error) {
      if (error instanceof ContentNotFoundError) return null;
      throw error;
    }
  }

  if (
    (input.opening && metadata.documentKind !== 'opening') ||
    (input.expectedAuthorId !== undefined && metadata.authorId !== input.expectedAuthorId) ||
    (input.expectedLicence !== undefined && metadata.licence !== input.expectedLicence)
  )
    return null;

  const thread = (
    await snapshot(deps, input.target.threadId, anonymousContext, (client) =>
      client.query<{ board_id: string }>(`SELECT board_id FROM content.thread WHERE route=$1 AND thread_id=$2`, [
        route,
        input.target.threadId,
      ]),
    )
  ).value.rows[0];
  if (!thread) return null;
  const boardRoute = routeOf(thread.board_id);
  if (boardRoute === null) return null;
  const board = (
    await snapshot(deps, thread.board_id, anonymousContext, (client) =>
      client.query<{ realm_id: string | null }>(`SELECT realm_id FROM content.board WHERE route=$1 AND board_id=$2`, [
        boardRoute,
        thread.board_id,
      ]),
    )
  ).value.rows[0];
  if (!board) return null;

  const homes = new Set<number>();
  for (const identity of [
    input.catalogueId,
    input.target.threadId,
    input.target.postId,
    input.target.revisionId,
    metadata.authorId,
    thread.board_id,
    ...(input.additionalAuthorityIds ?? []),
  ]) {
    const home = homeOf(identity);
    if (home === null) return null;
    homes.add(home);
  }
  if (board.realm_id) {
    const realmRoute = routeOf(board.realm_id);
    if (realmRoute === null) return null;
    const realm = (
      await snapshot(deps, board.realm_id, anonymousContext, (client) =>
        client.query<{ space_id: string }>(`SELECT space_id FROM community.realm WHERE route=$1 AND realm_id=$2`, [
          realmRoute,
          board.realm_id,
        ]),
      )
    ).value.rows[0];
    if (!realm) return null;
    for (const identity of [board.realm_id, realm.space_id]) {
      const home = homeOf(identity);
      if (home === null) return null;
      homes.add(home);
    }
  }
  return { authorId: metadata.authorId, licence: metadata.licence, homes: [...homes].sort((a, b) => a - b) };
}

/**
 * Prepare the public catalogue opening and each changed exact target. Public
 * targets retain their anonymous Access observation; a private opening can use
 * only existing exact catalogue-scoped consent. Commit rechecks both the
 * source incarnation and issued consent row through Content's native exports.
 */
export async function prepareHostedPointDisclosureEligibility(
  deps: HostedDependencies,
  catalogueOpening: HostedChapterTarget,
  catalogueId: string,
  newlySelectedTargets: readonly HostedChapterTarget[],
  context: ReadContext,
): Promise<HostedPointDisclosureEligibility | null> {
  const opening = await preparePublicSource(deps, catalogueOpening, context, true);
  if (!opening) return null;

  const publicObservations: HostedPointPublicEligibility[] = [opening];
  const privateObservations: Array<Readonly<{ disclosureId: string; source: RevisionDisclosureSource }>> = [];
  const seen = new Set([hostedTargetKey(catalogueOpening)]);

  for (const target of newlySelectedTargets) {
    const key = hostedTargetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);

    const publicObservation = await preparePublicSource(deps, target, context, false);
    if (publicObservation) {
      publicObservations.push(publicObservation);
      continue;
    }

    const consent = await observeIssuedRevisionDisclosure(deps, { catalogueId, target }, context);
    if (!consent) return null;
    privateObservations.push({ disclosureId: consent.disclosureId, source: disclosureSource(consent) });
  }

  return {
    async final(client) {
      for (const observation of publicObservations) if (!(await observation.final())) return false;
      for (const observation of privateObservations) {
        if (!(await revisionDisclosureSourceCurrent(client, observation.source))) return false;
        if (!(await revisionDisclosureStillIssued(client, observation.disclosureId))) return false;
      }
      return true;
    },
  };
}
