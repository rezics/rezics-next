import type { ReadContext } from './model.ts';
import type { AccessClient } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, readPostMetadata, type NativePostMetadata, type RetainContentRead } from './reads.ts';
import { hostedTargetKey } from './hosted-chapters-disclosure.ts';
import type { HostedChapterTarget, HostedDependencies } from './hosted-chapters-model.ts';
import {
  observeIssuedRevisionDisclosure,
  revisionDisclosureSourceCurrent,
  revisionDisclosureStillIssued,
  type RevisionDisclosureSource,
} from './revision-disclosure.ts';

const anonymous = Object.freeze({ kind: 'anonymous' as const });

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
