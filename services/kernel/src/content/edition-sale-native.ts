import type { Pool } from 'pg';
import { createInitiatorRestorer, DurableInitiatorUnavailableError } from '../access/durable-initiator.ts';
import { createAuthConsentReader, readAuthConsentConfig, type CurrentConsentReader } from '../access/auth-consent.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { accessCheck, type Access } from '../request/access.ts';
import type { ContentEditionSaleAuthority } from './edition-model.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { ReadContext } from './model.ts';
import { prepareEditionSource, prepareEditionPublisherSource } from './reads.ts';
import {
  editionBenefit,
  editionRow,
  editionSnapshot,
  editionSource,
  sameEdition,
  sameSource,
  sourceOf,
  withEditionReadTime,
  type EditionRow,
} from './edition-store.ts';
import { readEditionInitiator, EDITION_PUBLISH } from './edition-initiator.ts';

/** Trusted composition builds this once from Auth configuration; absent configuration yields no reader. */
export type ContentEditionConsentReader = CurrentConsentReader;
export function readContentEditionConsent(
  env: Readonly<Record<string, string | undefined>>,
): ContentEditionConsentReader | undefined {
  const config = readAuthConsentConfig(env);
  return config === null ? undefined : createAuthConsentReader(config);
}

type Dependencies = Readonly<{ pool: Pool; access: Access; clock?: () => Date; readConsent?: CurrentConsentReader }>;

/** Server-only Commerce eligibility port. It never authorizes delivery to a buyer. */
export function readContentEditionMechanicalSaleAuthority(
  dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  editionId: string,
  context: Readonly<{ deadline: number }>,
): Promise<ContentEditionSaleAuthority | null> {
  if (routeOf(editionId) === null) return Promise.resolve(null);
  const boundedContext = { deadline: Math.min(context.deadline, Date.now() + 1000) };
  return withEditionReadTime(dependencies, boundedContext, async (time) => {
    const prepared = await prepareNativeContentEditionSale(dependencies, editionId, boundedContext, time);
    return prepared && (await prepared.final()) ? prepared.authority : null;
  });
}

/** Current seller restoration uses the actual Auth configuration and two independent actions.
 * The request actor remains the buyer for every parent/Realm/Space read. */
export async function prepareContentEditionSale(
  deps: Dependencies,
  editionId: string,
  context: ReadContext,
  time: AuthoritativeTime,
): Promise<Readonly<{
  row: EditionRow;
  authority: ContentEditionSaleAuthority;
  final(): Promise<boolean>;
}> | null> {
  return prepareNativeContentEditionSale(deps, editionId, context, time, context);
}

/** Both owner ports use the identical native association, provenance and current seller verifier. */
async function prepareNativeContentEditionSale(
  deps: Dependencies,
  editionId: string,
  context: Readonly<{ deadline: number }>,
  time: AuthoritativeTime,
  caller?: ReadContext,
): Promise<Readonly<{
  row: EditionRow;
  authority: ContentEditionSaleAuthority;
  final(): Promise<boolean>;
}> | null> {
  const deadline = Math.min(context.deadline, Date.now() + 1000);
  context = { deadline };
  const row = (await editionSnapshot(deps, editionId, context, (client) => editionRow(client, editionId))).value;
  if (!row || row.state !== 'published') return null;
  const source = sourceOf(row);
  if (
    !sameSource(
      (
        await editionSnapshot(deps, editionId, context, (client) =>
          editionSource(client, row.post_id, row.revision_id, row.target_subject_id),
        )
      ).value,
      source,
    )
  )
    return null;
  const publication = (
    await editionSnapshot(
      deps,
      editionId,
      context,
      async (client) =>
        (
          await client.query<{ operation_id: string }>(
            'SELECT operation_id FROM content.edition_publication WHERE route=$1 AND edition_id=$2',
            [row.route, editionId],
          )
        ).rows[0] ?? null,
    )
  ).value;
  if (!publication) throw new AccessUnavailableError('overloaded');
  const readConsent = deps.readConsent;
  if (!readConsent) throw new AccessUnavailableError('overloaded');
  const restorer = createInitiatorRestorer({
    pool: deps.pool,
    access: deps.access,
    readOperation: readEditionInitiator,
    readConsent,
  });
  const operation = { route: row.route, id: publication.operation_id, kind: EDITION_PUBLISH, sourceId: editionId };
  // The same deadline bounds preparation and final. Neither restoration may refresh the other's budget.
  const accessContext = { pool: deps.pool, deadline, time };
  const nativeBinding = async (client: Parameters<Access['authorize']>[0]) =>
    sameEdition(await editionRow(client, editionId), row) &&
    sameSource(await editionSource(client, row.post_id, row.revision_id, row.target_subject_id), source);
  let sellerCheck: Awaited<ReturnType<typeof accessCheck>>;
  let authorCheck: Awaited<ReturnType<typeof accessCheck>>;
  try {
    const seller = await restorer.restoreInitiator(
      {
        operation,
        action: 'edition:sell',
        anchor: { resource: { route: row.route, id: editionId }, validate: nativeBinding },
        context: accessContext,
      },
      time,
    );
    const author = await restorer.restoreInitiator(
      {
        operation,
        action: 'post:revise',
        anchor: { resource: { route: row.route, id: row.post_id }, validate: nativeBinding },
        context: accessContext,
      },
      time,
    );
    if (seller.accountId !== row.creator_account_id || author.accountId !== row.creator_account_id)
      throw new AccessUnavailableError('overloaded');
    sellerCheck = await accessCheck(
      deps.access,
      seller,
      'edition:sell',
      { route: row.route, id: editionId },
      commandAccessContext(accessContext, {
        time,
        partition: partitionOf(row.route),
        basis: {
          actorAccountId: seller.accountId,
          clientId: seller.clientId,
          requestedBy: seller.requestedBy,
        },
      }),
    );
    authorCheck = await accessCheck(
      deps.access,
      author,
      'post:revise',
      { route: row.route, id: row.post_id },
      commandAccessContext(accessContext, {
        time,
        partition: partitionOf(row.route),
        basis: {
          actorAccountId: author.accountId,
          clientId: author.clientId,
          requestedBy: author.requestedBy,
        },
      }),
    );
  } catch (error) {
    if (error instanceof DurableInitiatorUnavailableError) throw new AccessUnavailableError('overloaded');
    throw error;
  }
  const publisherSource = await prepareEditionPublisherSource(deps, source, operation, restorer, time, accessContext);
  if (!publisherSource || !(await publisherSource.final())) return null;
  // A real caller keeps its own current subject and complete parent-chain checks.
  // Mechanical eligibility has no delivery actor and cannot issue a buyer fact.
  const callerSource = caller
    ? await prepareEditionSource(deps, source, { ...caller, deadline }, time, accessContext, false)
    : null;
  if (caller && (!callerSource || !(await callerSource.final()))) return null;
  const authority: ContentEditionSaleAuthority = {
    benefit: editionBenefit(row),
    targetSubjectId: row.target_subject_id,
    creatorAccountId: row.creator_account_id,
    licence: row.licence,
    source: {
      threadId: row.thread_id,
      postId: row.post_id,
      revisionId: row.revision_id,
      sha256: row.sha256,
    },
    editionRevision: row.security_revision,
  };
  return {
    row,
    authority,
    async final() {
      if (Date.now() >= accessContext.deadline) throw new AccessUnavailableError('deadline');
      if (!(await publisherSource.final()) || (callerSource && !(await callerSource.final()))) return false;
      const valid = (
        await editionSnapshot(
          deps,
          editionId,
          accessContext,
          async (client) =>
            (await nativeBinding(client)) &&
            (await publisherSource.check(client)) &&
            (!callerSource || (await callerSource.check(client))) &&
            (await sellerCheck(client, time)) &&
            (await authorCheck(client, time)) &&
            (await readEditionInitiator(client, operation, time)) !== null,
        )
      ).value;
      if (Date.now() >= accessContext.deadline) throw new AccessUnavailableError('deadline');
      return valid;
    },
  };
}

export function readContentEditionSaleAuthority(
  dependencies: Readonly<{ pool: Pool; access: Access; clock?: () => Date }>,
  editionId: string,
  context: ReadContext,
): Promise<ContentEditionSaleAuthority | null> {
  if (routeOf(editionId) === null) return Promise.resolve(null);
  const boundedContext = { ...context, deadline: Math.min(context.deadline, Date.now() + 1000) };
  return withEditionReadTime(dependencies, boundedContext, async (time) => {
    const prepared = await prepareContentEditionSale(dependencies, editionId, boundedContext, time);
    return prepared && (await prepared.final()) ? prepared.authority : null;
  });
}
