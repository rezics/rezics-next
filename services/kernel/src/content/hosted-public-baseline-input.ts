import { createHash } from 'node:crypto';
import type { Actor, AccessClient } from '../request/access.ts';
import { noEffect, principalCommandIdentity, runCommand, type CommandTransaction } from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, RevisionPreconditionError } from './commands.ts';
import { discloseHostedTargetMetadata, hostedTargetKey } from './hosted-chapters-disclosure.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import type { HostedChapterTarget, HostedCommandContext } from './hosted-chapters-model.ts';
import { snapshot } from './reads.ts';
import readLastOrdinal from './hosted-public-baseline-input-last.sql';
import readOrdinalKeys from './hosted-public-baseline-input-keys.sql';
import readManifestPageRows from './hosted-public-baseline-input-entries.sql';
import {
  HostedPublicBaselineInputIncompleteError,
  HostedPublicBaselineInputUnavailableError,
  HOSTED_PUBLIC_BASELINE_INPUT_PAGE_MAX,
  InvalidHostedPublicBaselineInputError,
  type HostedPublicBaselineCapture,
  type HostedPublicBaselineCaptureResult,
  type HostedPublicBaselineEntry,
  type HostedPublicBaselineFrontier,
  type HostedPublicBaselinePage,
  type HostedPublicBaselinePageResult,
  type HostedPublicBaselineSource,
} from './hosted-public-baseline-input-model.ts';

export type HostedPublicBaselineInputDependencies = HostedCommandDependencies;

type LastOrdinalRow = { ordinal: string };
type OrdinalRow = { ordinal: string };
type PublicCatalogueRow = {
  route: number;
  catalogue_id: string;
  thread_id: string;
  publication_id: string | null;
};
type ManifestRow = {
  ordinal: string;
  occurrence_id: string;
  parent_id: string | null;
  position: number;
  title: string | null;
  title_redacted: boolean;
  kind: 'part' | 'chapter';
  thread_id: string | null;
  post_id: string | null;
  target_revision_id: string | null;
  sha256: string | null;
};

type Interval = Readonly<{
  afterOrdinal: number;
  throughOrdinal: number;
  itemCount: number;
  complete: boolean;
}>;
type ScannedPage = Readonly<{
  interval: Interval;
  sourceCurrent: boolean;
  rows: readonly ManifestRow[];
}>;
type RecheckedPage = Readonly<{ sourceCurrent: boolean; rows: readonly ManifestRow[] }>;

const CAPTURE_KIND = 'content.hosted-catalogue.public-baseline.capture';
const PAGE_KIND = 'content.hosted-catalogue.public-baseline.page';
const PUBLIC_CATALOGUE_SELECT = `
  SELECT route,catalogue_id,thread_id,publication_id
  FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`;

function requireAccount(actor: Actor): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
}

/** Bind resumable source handles to the same native actor context as the
 * installed private cursor, without storing its access token or raw scopes. */
function actorBinding(actor: Extract<Actor, { kind: 'account' }>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([actor.accountId, actor.clientId, actor.requestedBy, actor.authnEpoch, [...actor.scopes].sort()]),
    )
    .digest('hex');
}

function routeFor(catalogueId: string, publicationId?: string, threadId?: string): number {
  const route = routeOf(catalogueId);
  if (
    route === null ||
    (publicationId !== undefined && routeOf(publicationId) !== route) ||
    (threadId !== undefined && routeOf(threadId) !== route)
  )
    throw new InvalidHostedPublicBaselineInputError('Invalid hosted public baseline identity');
  return route;
}

function assertSource(source: HostedPublicBaselineSource, actor: Extract<Actor, { kind: 'account' }>): number {
  const route = routeFor(source.catalogueId, source.publicationId, source.threadId);
  if (
    source.route !== route ||
    !Number.isSafeInteger(source.expectedPlacementCount) ||
    source.expectedPlacementCount < 0
  )
    throw new InvalidHostedPublicBaselineInputError('Invalid hosted public baseline source');
  if (source.actorBinding !== actorBinding(actor)) throw new ContentNotFoundError();
  return route;
}

function assertFrontier(frontier: HostedPublicBaselineFrontier, expected: number): void {
  if (!Number.isSafeInteger(frontier.afterOrdinal) || frontier.afterOrdinal < -1 || frontier.afterOrdinal >= expected)
    throw new InvalidHostedPublicBaselineInputError('Invalid hosted public baseline frontier');
}

async function admittedCatalogue(
  dependencies: HostedPublicBaselineInputDependencies,
  actor: Actor,
  catalogueId: string,
  context: HostedCommandContext,
  receipt: Readonly<{ kind: string; key: string; digest: Uint8Array }>,
) {
  requireAccount(actor);
  const observed = await snapshot(dependencies, catalogueId, context, (client) => publicCatalogue(client, catalogueId));
  if (!observed.value || routeOf(observed.value.thread_id) !== routeOf(catalogueId))
    throw new HostedPublicBaselineInputUnavailableError();
  const authorization = hostedPostAuthorization(
    dependencies,
    actor,
    observed.value.thread_id,
    catalogueId,
    context,
    receipt,
  );
  return { threadId: observed.value.thread_id, authorization };
}

async function publicCatalogue(client: AccessClient, catalogueId: string, lock = false) {
  const route = routeOf(catalogueId);
  if (route === null) throw new InvalidHostedPublicBaselineInputError('Invalid hosted public baseline identity');
  return (
    (
      await client.query<PublicCatalogueRow>(`${PUBLIC_CATALOGUE_SELECT}${lock ? ' FOR UPDATE' : ''}`, [
        route,
        catalogueId,
      ])
    ).rows[0] ?? null
  );
}

async function expectedPlacementCount(client: AccessClient, route: number, catalogueId: string, publicationId: string) {
  const last = (await readLastOrdinal.run(client, {
    route,
    catalogue_id: catalogueId,
    publication_id: publicationId,
  })) as LastOrdinalRow | undefined;
  if (!last) return 0;
  const ordinal = Number(last.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new HostedPublicBaselineInputIncompleteError();
  return ordinal + 1;
}

async function requirePublication(
  client: AccessClient,
  route: number,
  catalogueId: string,
  publicationId: string,
): Promise<void> {
  const revision = (
    await client.query<{ present: number }>(
      `SELECT 1 AS present FROM content.hosted_structure_revision
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND kind='publication'`,
      [route, catalogueId, publicationId],
    )
  ).rows[0];
  if (!revision) throw new HostedPublicBaselineInputUnavailableError();
}

/** Capture the active public manifest by identity. Publication placements are
 * immutable and retained for old links, so this source needs no second hold
 * table; the generation builder persists the returned source with its own
 * private candidate progress. */
export async function captureHostedPublicBaselineInput(
  dependencies: HostedPublicBaselineInputDependencies,
  actor: Actor,
  input: HostedPublicBaselineCapture,
  context: HostedCommandContext,
) {
  requireAccount(actor);
  const route = routeFor(input.catalogueId, input.expectedPublicationId);
  const receipt = {
    kind: CAPTURE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(CAPTURE_KIND, actor, input),
  };
  const admission = await admittedCatalogue(dependencies, actor, input.catalogueId, context, receipt);
  return runCommand<HostedPublicBaselineCaptureResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx) => {
      const catalogue = await publicCatalogue(tx, input.catalogueId, true);
      if (!catalogue || catalogue.thread_id !== admission.threadId)
        throw new HostedPublicBaselineInputUnavailableError();
      if (!catalogue.publication_id) throw new HostedPublicBaselineInputUnavailableError();
      if (catalogue.publication_id !== input.expectedPublicationId) throw new RevisionPreconditionError();
      await requirePublication(tx, route, input.catalogueId, input.expectedPublicationId);
      const expected = await expectedPlacementCount(tx, route, input.catalogueId, input.expectedPublicationId);
      const source: HostedPublicBaselineSource = {
        catalogueId: input.catalogueId,
        route,
        threadId: catalogue.thread_id,
        publicationId: input.expectedPublicationId,
        actorBinding: actorBinding(actor),
        expectedPlacementCount: expected,
      };
      return noEffect({ source, frontier: { afterOrdinal: -1 } });
    },
  );
}

async function selectManifestRows(
  client: AccessClient,
  source: HostedPublicBaselineSource,
  afterOrdinal: number,
  throughOrdinal: number,
  limit: number,
): Promise<ManifestRow[]> {
  if (throughOrdinal === afterOrdinal) return [];
  return (await readManifestPageRows.run(client, {
    route: source.route,
    catalogue_id: source.catalogueId,
    publication_id: source.publicationId,
    after_ordinal: afterOrdinal,
    through_ordinal: throughOrdinal,
    limit,
  })) as ManifestRow[];
}

function ordinalOf(row: OrdinalRow | ManifestRow): number {
  const ordinal = Number(row.ordinal);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new HostedPublicBaselineInputIncompleteError();
  return ordinal;
}

function assertContiguousRows(rows: readonly (OrdinalRow | ManifestRow)[], afterOrdinal: number): void {
  let expected = afterOrdinal + 1;
  for (const row of rows) {
    if (ordinalOf(row) !== expected) throw new HostedPublicBaselineInputIncompleteError();
    expected++;
  }
}

async function scanPage(
  tx: CommandTransaction,
  source: HostedPublicBaselineSource,
  afterOrdinal: number,
  limit: number,
): Promise<ScannedPage> {
  const catalogue = await publicCatalogue(tx, source.catalogueId);
  if (!catalogue || catalogue.thread_id !== source.threadId) throw new HostedPublicBaselineInputUnavailableError();
  await requirePublication(tx, source.route, source.catalogueId, source.publicationId);
  const expected = await expectedPlacementCount(tx, source.route, source.catalogueId, source.publicationId);
  if (expected !== source.expectedPlacementCount) throw new HostedPublicBaselineInputIncompleteError();

  const keys = (await readOrdinalKeys.run(tx, {
    route: source.route,
    catalogue_id: source.catalogueId,
    publication_id: source.publicationId,
    after_ordinal: afterOrdinal,
    limit: limit + 1,
  })) as OrdinalRow[];
  assertContiguousRows(keys, afterOrdinal);
  const hasMore = keys.length > limit;
  const selected = hasMore ? keys.slice(0, limit) : keys;
  const throughOrdinal = selected.length ? ordinalOf(selected.at(-1)!) : afterOrdinal;
  if (!hasMore && throughOrdinal + 1 !== expected) throw new HostedPublicBaselineInputIncompleteError();
  if (hasMore && throughOrdinal + 1 >= expected) throw new HostedPublicBaselineInputIncompleteError();

  const rows = await selectManifestRows(tx, source, afterOrdinal, throughOrdinal, selected.length);
  if (rows.length !== selected.length) throw new HostedPublicBaselineInputIncompleteError();
  assertContiguousRows(rows, afterOrdinal);
  return {
    interval: { afterOrdinal, throughOrdinal, itemCount: rows.length, complete: !hasMore },
    sourceCurrent: catalogue.publication_id === source.publicationId,
    rows,
  };
}

function targetOf(row: ManifestRow): HostedChapterTarget | null {
  if (row.kind !== 'chapter') return null;
  if (!row.thread_id || !row.post_id || !row.target_revision_id || !row.sha256) return null;
  return {
    threadId: row.thread_id,
    postId: row.post_id,
    revisionId: row.target_revision_id,
    sha256: row.sha256,
  };
}

function stableAddressMatches(initial: ManifestRow, current: ManifestRow): boolean {
  return (
    initial.ordinal === current.ordinal &&
    initial.occurrence_id === current.occurrence_id &&
    initial.parent_id === current.parent_id &&
    initial.position === current.position &&
    initial.kind === current.kind
  );
}

function sameTarget(left: HostedChapterTarget | null, right: HostedChapterTarget | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

function unavailable(source: HostedPublicBaselineSource, row: ManifestRow): HostedPublicBaselineEntry {
  const common = {
    publicationId: source.publicationId,
    occurrenceId: row.occurrence_id,
    parentId: row.parent_id,
    position: row.position,
    ordinal: ordinalOf(row),
  };
  return row.kind === 'part'
    ? { ...common, availability: 'unavailable', kind: 'part' }
    : { ...common, availability: 'unavailable', kind: 'chapter' };
}

function availableSourceTitle(initial: ManifestRow, current: ManifestRow): current is ManifestRow & { title: string } {
  return (
    !current.title_redacted && current.title !== null && current.title === initial.title && !initial.title_redacted
  );
}

function projectRow(
  source: HostedPublicBaselineSource,
  initial: ManifestRow,
  current: ManifestRow,
  visibleTargets: ReadonlyMap<string, boolean>,
): HostedPublicBaselineEntry {
  if (!stableAddressMatches(initial, current)) throw new HostedPublicBaselineInputIncompleteError();
  if (!availableSourceTitle(initial, current)) return unavailable(source, current);

  const common = {
    publicationId: source.publicationId,
    occurrenceId: current.occurrence_id,
    parentId: current.parent_id,
    position: current.position,
    ordinal: ordinalOf(current),
  };
  if (current.kind === 'part') return { ...common, availability: 'available', kind: 'part', title: current.title };

  const initialTarget = targetOf(initial);
  const currentTarget = targetOf(current);
  if (
    !initialTarget ||
    !currentTarget ||
    !sameTarget(initialTarget, currentTarget) ||
    visibleTargets.get(hostedTargetKey(initialTarget)) !== true
  )
    return unavailable(source, current);
  return { ...common, availability: 'available', kind: 'chapter', title: current.title, target: currentTarget };
}

async function recheckPage(
  dependencies: HostedPublicBaselineInputDependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  source: HostedPublicBaselineSource,
  interval: Interval,
  context: HostedCommandContext,
): Promise<RecheckedPage> {
  const receipt = {
    kind: `${PAGE_KIND}.read`,
    key: context.idempotencyKey,
    digest: requestDigest(`${PAGE_KIND}.read`, actor, { source, interval }),
  };
  const admission = await admittedCatalogue(dependencies, actor, source.catalogueId, context, receipt);
  const result = await runCommand<RecheckedPage>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(source.route),
      deadline: context.deadline,
      clock: dependencies.clock,
      authorization: admission.authorization,
    },
    async (tx) => {
      const catalogue = await publicCatalogue(tx, source.catalogueId);
      if (!catalogue || catalogue.thread_id !== source.threadId) throw new HostedPublicBaselineInputUnavailableError();
      await requirePublication(tx, source.route, source.catalogueId, source.publicationId);
      const expected = await expectedPlacementCount(tx, source.route, source.catalogueId, source.publicationId);
      if (expected !== source.expectedPlacementCount) throw new HostedPublicBaselineInputIncompleteError();
      const rows = await selectManifestRows(
        tx,
        source,
        interval.afterOrdinal,
        interval.throughOrdinal,
        interval.itemCount,
      );
      if (rows.length !== interval.itemCount) throw new HostedPublicBaselineInputIncompleteError();
      assertContiguousRows(rows, interval.afterOrdinal);
      return noEffect({ sourceCurrent: catalogue.publication_id === source.publicationId, rows });
    },
  );
  return result.value;
}

/** Read one bounded interval from the captured publication. Ordinals are raw
 * preorder addresses: private or erased entries still consume their slot, and
 * a newer draft or publication is never used to fill a gap. */
export async function readHostedPublicBaselineInputPage(
  dependencies: HostedPublicBaselineInputDependencies,
  actor: Actor,
  source: HostedPublicBaselineSource,
  page: HostedPublicBaselinePage,
  context: HostedCommandContext,
): Promise<HostedPublicBaselinePageResult> {
  requireAccount(actor);
  const route = assertSource(source, actor);
  const limit = page.limit ?? HOSTED_PUBLIC_BASELINE_INPUT_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_PUBLIC_BASELINE_INPUT_PAGE_MAX)
    throw new InvalidHostedPublicBaselineInputError('Hosted public baseline page size is outside its bound');
  assertFrontier(page.frontier, source.expectedPlacementCount);

  const receipt = {
    kind: PAGE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(PAGE_KIND, actor, { source, frontier: page.frontier, limit }),
  };
  const admission = await admittedCatalogue(dependencies, actor, source.catalogueId, context, receipt);
  if (admission.threadId !== source.threadId) throw new HostedPublicBaselineInputUnavailableError();
  const scanned = await runCommand<ScannedPage>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      authorization: admission.authorization,
    },
    async (tx) => noEffect(await scanPage(tx, source, page.frontier.afterOrdinal, limit)),
  );

  const visibleTargets = new Map<string, boolean>();
  for (const row of scanned.value.rows) {
    const target = targetOf(row);
    if (!target || row.title === null || row.title_redacted) continue;
    const key = hostedTargetKey(target);
    if (!visibleTargets.has(key)) {
      const disclosed = await discloseHostedTargetMetadata(dependencies, target, {
        actor,
        deadline: context.deadline,
      });
      visibleTargets.set(key, disclosed !== null);
    }
  }

  const final = await recheckPage(dependencies, actor, source, scanned.value.interval, context);
  const items = final.rows.map((row, index) => projectRow(source, scanned.value.rows[index]!, row, visibleTargets));
  const frontier = { afterOrdinal: scanned.value.interval.throughOrdinal };
  return {
    source,
    sourceCurrent: final.sourceCurrent,
    frontier,
    coverage: {
      visited: frontier.afterOrdinal + 1,
      expected: source.expectedPlacementCount,
      complete: scanned.value.interval.complete,
    },
    items,
  };
}
