import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import {
  AccessUnavailableError,
  classifyUnavailability,
  CommandUnavailableError,
  requireAccessDeadline,
} from '../access/unavailable.ts';
import { withBoundedReadConnection, withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor } from '../request/access.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readCurrentSubjectSummaries } from '../semantic/current-subject-summaries.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  captureCurrentContentEdition,
  contentPostTermsView,
  requireMechanicalContentPost,
  contentEditionTermsView,
  sameCapturedContentEdition,
  sameCapturedContentPost,
  type SaleDependencies,
} from './benefit.ts';
import type { Offer, PublicOfferCard, SubjectOffersPage } from './model.ts';
import { readOffer } from './store.ts';
import references from './subject-offers-page.sql';
import bootstrap from './subject-offers-bootstrap.sql';

export const SUBJECT_OFFER_RAW_LIMIT = 20;
export const SUBJECT_OFFER_START = '00000000-0000-0000-0000-000000000000';
const boundedReadOptions = {
  deadlineError: () => new AccessUnavailableError('deadline'),
  // A server ERROR has settled; other native query failures can leave IO unresolved.
  isUncertainSettledQueryError: () => true,
};
type Dependencies = {
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  tokens: KeyRing;
  readConsent?: NonNullable<SaleDependencies['readConsent']>;
  clock: () => Date;
};

/** Native creator-home point. This never consults directory prices or permission copies. */
export async function readSubjectOfferSource(pool: Pool, id: string, deadline: number): Promise<Offer | null> {
  const route = routeOf(id);
  if (route === null) return null;
  const source = await withBoundedReadOnlyTransaction(
    pool,
    deadline,
    async (client) => {
      const owner = await readPartition(client, partitionOf(route));
      if (!owner || owner.writeState !== 'active')
        throw new CommandUnavailableError(
          owner?.writeState === 'moved' ? 'moved' : 'fenced',
          partitionOf(route),
          owner?.movedTo,
        );
      const offer = await readOffer(client, route, id);
      if (!offer) return null;
      const creator = await readAccount(client, route, offer.creatorAccountId);
      if (!creator) throw new ProblemError('dependency_unavailable');
      return { offer, creator };
    },
    boundedReadOptions,
  );
  // Evaluate the captured creator after COMMIT and release, before any foreign preparation.
  if (!source || source.creator.state !== 'active' || source.creator.fenced) return null;
  return source.offer;
}

/** The existing active public offer floor, evaluated by the sole native Access formula.
 * Public terms are neither order:create nor edition:read permission. Named denials remain binding.
 */
async function mayReadOffer(deps: Dependencies, actor: Actor, offer: Offer, deadline: number): Promise<boolean> {
  const resource = { route: routeOf(offer.id)!, id: offer.id };
  const check = await accessCheck(
    deps.access,
    actor,
    'offer:read',
    {
      ...resource,
      eligibility: createResourcePublicEligibility({
        resource,
        action: 'offer:read',
        async prepare() {
          return { revision: offer.revision };
        },
        async verify({ client, evidence }) {
          const current = await readOffer(client, resource.route, resource.id);
          return (
            current?.state === 'active' &&
            current.revision === evidence.revision &&
            (current.contentEdition != null) !== (current.contentPost != null)
          );
        },
      }),
    },
    { pool: deps.pool, deadline },
  );
  return withBoundedReadConnection(deps.pool, deadline, (client) => check(client), boundedReadOptions);
}

export function publicOfferCard(offer: Offer): PublicOfferCard {
  return {
    id: offer.id,
    targetSubjectId: offer.targetSubjectId,
    title: offer.title,
    currency: offer.currency,
    unitAmountMinor: offer.unitAmountMinor,
    moneyUnit: offer.moneyUnit ?? null,
    taxBehavior: offer.taxBehavior ?? null,
    revision: offer.revision,
    contentEdition: contentEditionTermsView(offer.contentEdition),
    contentPost: contentPostTermsView(offer.contentPost),
  };
}

/** Eventual positive discovery. Rejects consume raw slots and advance the signed raw cursor. */
export function listSubjectOffers(
  deps: Dependencies,
  actor: Actor,
  subject: string,
  input: { cursor?: string; limit?: number; deadline: number },
): Promise<SubjectOffersPage> {
  return withRequestDeadline(input.deadline, async (): Promise<SubjectOffersPage> => {
    const size = input.limit ?? 10;
    if (!Number.isInteger(size) || size < 1 || size > SUBJECT_OFFER_RAW_LIMIT)
      throw new ProblemError('invalid_request');
    if (routeOf(subject) === null) throw new ProblemError('not_found');
    const disclosure = () => readCurrentSubjectSummaries({ ...deps, actor, deadline: input.deadline }, [subject]);
    const before = await disclosure();
    if (!before.summaries.get(subject)) throw new ProblemError('not_found');
    const [identity] = await readIdentityMappings(deps.pool, [subject]);
    if (identity?.state !== 'mapped') {
      await before.verify();
      return { offers: [], next: null, projectionState: 'preparing' };
    }
    const terminal = identity.terminal;
    const route = routeOf(terminal)!;
    const binding = {
      operation: 'subject_offers.list',
      parameters: { subject, terminal, identityEpoch: identity.epoch.toString(), order: 'raw-offer-id-asc-v1' },
    };
    let after = SUBJECT_OFFER_START;
    let cursorEpoch: number | undefined;
    if (input.cursor !== undefined) {
      const decoded = decodeCursor(deps.tokens, binding, input.cursor);
      if (
        !decoded.ok ||
        decoded.after.length !== 1 ||
        typeof decoded.after[0] !== 'string' ||
        routeOf(decoded.after[0]) === null
      )
        throw new ProblemError('invalid_cursor');
      after = decoded.after[0];
      cursorEpoch = decoded.epoch;
    }
    const directory = await withBoundedReadConnection(
      deps.pool,
      input.deadline,
      async (client) => {
        const owner = await readPartition(client, partitionOf(route));
        if (!owner || owner.writeState !== 'active') throw new ProblemError('dependency_unavailable');
        if (cursorEpoch !== undefined && cursorEpoch !== owner.epoch) throw new ProblemError('stale_cursor');
        const rows = await references.run(client, { route, subject: terminal, after, limit: size });
        return { rows, epoch: owner.epoch };
      },
      boundedReadOptions,
    );
    // Release the directory before every creator, Content and Subject home.
    const state = await withBoundedReadConnection(
      deps.pool,
      input.deadline,
      async (client) => {
        const owner = await readPartition(client, 0);
        if (!owner || owner.writeState !== 'active') return null;
        return bootstrap.run(client, {});
      },
      boundedReadOptions,
    );
    let preparing = !state?.ready;
    const offers: PublicOfferCard[] = [];
    for (const ref of directory.rows) {
      requireAccessDeadline(input.deadline);
      if (!ref.listed) continue;
      try {
        const offer = await readSubjectOfferSource(deps.pool, ref.offerId, input.deadline);
        if (
          !offer ||
          offer.state !== 'active' ||
          offer.revision !== ref.sourceRevision ||
          (offer.contentEdition == null) === (offer.contentPost == null) ||
          !Number.isSafeInteger(offer.unitAmountMinor) ||
          offer.unitAmountMinor < 1 ||
          offer.targetSubjectId !== ref.originalSubjectId ||
          offer.creatorAccountId !== (offer.contentPost ?? offer.contentEdition)!.creatorAccountId ||
          offer.targetSubjectId !== (offer.contentPost ?? offer.contentEdition)!.targetSubjectId
        )
          continue;
        const [mapped] = await readIdentityMappings(deps.pool, [offer.targetSubjectId]);
        if (mapped?.state !== 'mapped') {
          preparing = true;
          continue;
        }
        if (mapped.terminal !== terminal || mapped.epoch.toString() !== ref.identityEpoch) continue;
        const subjects = await readCurrentSubjectSummaries({ ...deps, actor, deadline: input.deadline }, [
          offer.targetSubjectId,
        ]);
        if (!subjects.summaries.get(offer.targetSubjectId) || !(await mayReadOffer(deps, actor, offer, input.deadline)))
          continue;
        const current = offer.contentPost
          ? await requireMechanicalContentPost(offer.contentPost, deps, { deadline: input.deadline })
          : await captureCurrentContentEdition(offer.contentEdition!.benefit.resource.id, deps, {
              actor,
              deadline: input.deadline,
            });
        if (
          offer.contentPost
            ? !sameCapturedContentPost(offer.contentPost, current as typeof offer.contentPost)
            : !sameCapturedContentEdition(
                offer.contentEdition,
                current as Awaited<ReturnType<typeof captureCurrentContentEdition>>,
              )
        )
          continue;
        const final = await readSubjectOfferSource(deps.pool, offer.id, input.deadline);
        if (
          !final ||
          final.state !== 'active' ||
          final.revision !== offer.revision ||
          (offer.contentPost
            ? !sameCapturedContentPost(final.contentPost, current as typeof offer.contentPost)
            : !sameCapturedContentEdition(
                final.contentEdition,
                current as Awaited<ReturnType<typeof captureCurrentContentEdition>>,
              )) ||
          !(await mayReadOffer(deps, actor, final, input.deadline))
        )
          continue;
        const [finalMapping] = await readIdentityMappings(deps.pool, [offer.targetSubjectId]);
        if (finalMapping?.state !== 'mapped') {
          preparing = true;
          continue;
        }
        if (finalMapping.terminal !== terminal || finalMapping.epoch !== mapped.epoch) continue;
        await subjects.verify();
        offers.push(publicOfferCard(final));
      } catch (error) {
        if (
          classifyUnavailability(error) ||
          (error instanceof ProblemError && error.code === 'dependency_unavailable')
        ) {
          preparing = true;
          continue;
        }
        throw error;
      }
    }
    // Revalidate the original and terminal after all point confirmations, with fresh native disclosure.
    await before.verify();
    const [finalIdentity] = await readIdentityMappings(deps.pool, [subject]);
    if (
      finalIdentity?.state !== 'mapped' ||
      finalIdentity.terminal !== terminal ||
      finalIdentity.epoch !== identity.epoch
    )
      return { offers: [], next: null, projectionState: 'preparing' };
    const finalDisclosure = await disclosure();
    if (!finalDisclosure.summaries.get(subject)) throw new ProblemError('not_found');
    await finalDisclosure.verify();
    await withBoundedReadConnection(
      deps.pool,
      input.deadline,
      async (client) => {
        const owner = await readPartition(client, partitionOf(route));
        if (!owner || owner.writeState !== 'active' || owner.epoch !== directory.epoch)
          throw new ProblemError('dependency_unavailable');
      },
      boundedReadOptions,
    );
    requireAccessDeadline(input.deadline);
    const last = directory.rows.at(-1);
    return {
      offers,
      next:
        directory.rows.length === size && last
          ? encodeCursor(deps.tokens, binding, { epoch: directory.epoch, after: [last.offerId] })
          : null,
      projectionState: preparing ? 'preparing' : 'ready',
    };
  }).catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42P01')
      throw new ProblemError('dependency_unavailable');
    throw error;
  });
}
