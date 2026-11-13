import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, RevisionPreconditionError } from './commands.ts';
import { discloseHostedTargetMetadata } from './hosted-chapters-disclosure.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import type { HostedCommandContext } from './hosted-chapters-model.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import { snapshot } from './reads.ts';
import {
  HostedMigrationInputIncompleteError,
  HostedMigrationInputUnavailableError,
  HOSTED_MIGRATION_INPUT_PAGE_MAX,
  HOSTED_MIGRATION_INPUT_RETENTION_MS,
  InvalidHostedMigrationInputError,
  type HostedMigrationEntry,
  type HostedMigrationFrontier,
  type HostedMigrationInputCapture,
  type HostedMigrationInputCaptureResult,
  type HostedMigrationInputPage,
  type HostedMigrationInputPageResult,
  type HostedMigrationInputRelease,
  type HostedMigrationInputReleaseResult,
  type HostedMigrationInputStatus,
  type HostedMigrationSourceIdentity,
} from './hosted-migration-input-model.ts';

export type HostedMigrationInputDependencies = HostedCommandDependencies;

type InputRow = {
  route: number;
  catalogue_id: string;
  input_id: string;
  owner_account_id: string;
  source_revision_id: string;
  source_kind: 'snapshot' | 'prefix';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  frontier_segment: 'base' | 'prefix' | 'complete';
  after_ordinal: string;
  after_offset: string;
  raw_visited: string;
  coverage_complete: boolean;
  state: HostedMigrationInputStatus;
  expires_at: Date | string;
};

type RevisionRow = { kind: 'structure' | 'publication' };
type DescriptorRow = {
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  high_water: string;
};
type BaseKeyRow = { ordinal: string };
type PrefixKeyRow = { append_offset: string };
type BaseEntryRow = {
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
type PrefixEntryRow = Omit<BaseEntryRow, 'ordinal' | 'position' | 'parent_id'> & { append_offset: string };

type PageInterval = Readonly<{
  start: HostedMigrationFrontier;
  end: HostedMigrationFrontier;
  count: string;
}>;
type PageCommit = Readonly<{
  inputId: string;
  source: HostedMigrationSourceIdentity;
  status: HostedMigrationInputStatus;
  frontier: HostedMigrationFrontier;
  visited: string;
  complete: boolean;
  interval: PageInterval | null;
}>;

const CAPTURE_KIND = 'content.hosted-catalogue.migration-input.capture';
const PAGE_KIND = 'content.hosted-catalogue.migration-input.page';
const RELEASE_KIND = 'content.hosted-catalogue.migration-input.release';
const INPUT_SELECT = `
  SELECT route,catalogue_id,input_id,owner_account_id,source_revision_id,source_kind,
         base_revision_id,base_placement_count::text,base_root_count::text,source_high_water::text,
         expected_placement_count::text,frontier_segment,after_ordinal::text,after_offset::text,
         raw_visited::text,coverage_complete,state,expires_at
  FROM content.hosted_migration_input
  WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`;

function requireAccount(actor: Actor): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
}

function routeFor(catalogueId: string, inputId?: string): number {
  const route = routeOf(catalogueId);
  if (route === null || (inputId !== undefined && routeOf(inputId) !== route))
    throw new InvalidHostedMigrationInputError('Invalid hosted migration input identity');
  return route;
}

function sourceIdentity(row: InputRow): HostedMigrationSourceIdentity {
  return {
    catalogueId: row.catalogue_id,
    revisionId: row.source_revision_id,
    kind: row.source_kind,
    baseRevisionId: row.base_revision_id,
    basePlacementCount: row.base_placement_count,
    baseRootCount: row.base_root_count,
    highWater: row.source_high_water,
    expectedPlacementCount: row.expected_placement_count,
  };
}

function frontier(row: InputRow): HostedMigrationFrontier {
  if (row.frontier_segment === 'complete') return { segment: 'complete' };
  if (row.frontier_segment === 'prefix') return { segment: 'prefix', afterOffset: row.after_offset };
  return { segment: 'base', afterOrdinal: Number(row.after_ordinal) };
}

function sameFrontier(left: HostedMigrationFrontier, right: HostedMigrationFrontier): boolean {
  if (left.segment !== right.segment) return false;
  if (left.segment === 'base' && right.segment === 'base') return left.afterOrdinal === right.afterOrdinal;
  if (left.segment === 'prefix' && right.segment === 'prefix') return left.afterOffset === right.afterOffset;
  return left.segment === 'complete' && right.segment === 'complete';
}

function assertFrontier(value: HostedMigrationFrontier, row: InputRow): void {
  if (value.segment === 'base') {
    if (
      !Number.isSafeInteger(value.afterOrdinal) ||
      value.afterOrdinal < -1 ||
      BigInt(value.afterOrdinal) >= BigInt(row.base_placement_count)
    )
      throw new InvalidHostedMigrationInputError('Invalid hosted migration base frontier');
  } else if (value.segment === 'prefix') {
    if (row.source_kind !== 'prefix' || !/^-1$|^(0|[1-9][0-9]*)$/.test(value.afterOffset))
      throw new InvalidHostedMigrationInputError('Invalid hosted migration prefix frontier');
    const offset = BigInt(value.afterOffset);
    if (offset < -1n || offset > BigInt(row.source_high_water))
      throw new InvalidHostedMigrationInputError('Invalid hosted migration prefix frontier');
  }
}

function expiresAt(time: Parameters<typeof authoritativeTimeValue>[0]): string {
  return new Date(Date.parse(authoritativeTimeValue(time)) + HOSTED_MIGRATION_INPUT_RETENTION_MS).toISOString();
}

async function admittedCatalogue(
  dependencies: HostedMigrationInputDependencies,
  actor: Actor,
  catalogueId: string,
  context: HostedCommandContext,
  receipt: Readonly<{ kind: string; key: string; digest: Uint8Array }>,
) {
  requireAccount(actor);
  const observed = await snapshot(dependencies, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  if (!observed.value || routeOf(observed.value.thread_id) !== routeOf(catalogueId)) throw new ContentNotFoundError();
  const authorization = hostedPostAuthorization(
    dependencies,
    actor,
    observed.value.thread_id,
    catalogueId,
    context,
    receipt,
  );
  return { route: routeFor(catalogueId), threadId: observed.value.thread_id, authorization };
}

async function loadInput(tx: CommandTransaction, route: number, catalogueId: string, inputId: string, lock = false) {
  const result = await tx.query<InputRow>(`${INPUT_SELECT}${lock ? ' FOR UPDATE' : ''}`, [route, catalogueId, inputId]);
  return result.rows[0] ?? null;
}

async function releaseHold(tx: CommandTransaction, route: number, catalogueId: string, inputId: string) {
  await tx.query(
    `DELETE FROM content.hosted_migration_input_reference
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
    [route, catalogueId, inputId],
  );
}

async function selectBaseKeys(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  revisionId: string,
  afterOrdinal: string,
  limit: number,
) {
  return (
    await tx.query<BaseKeyRow>(
      `SELECT p.ordinal::text
       FROM content.hosted_placement p
       WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3 AND p.ordinal>$4::bigint
       ORDER BY p.ordinal LIMIT $5`,
      [route, catalogueId, revisionId, afterOrdinal, limit],
    )
  ).rows;
}

async function selectPrefixKeys(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  streamId: string,
  afterOffset: string,
  highWater: string,
  limit: number,
) {
  return (
    await tx.query<PrefixKeyRow>(
      `SELECT a.append_offset::text
       FROM content.hosted_append a
       WHERE a.route=$1 AND a.catalogue_id=$2 AND a.stream_id=$3
         AND a.append_offset>$4::bigint AND a.append_offset<=$5::bigint
       ORDER BY a.append_offset LIMIT $6`,
      [route, catalogueId, streamId, afterOffset, highWater, limit],
    )
  ).rows;
}

function expiresOn(row: InputRow): number {
  return row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at);
}

async function expireInput(tx: CommandTransaction, row: InputRow) {
  await tx.query(
    `UPDATE content.hosted_migration_input SET state='expired',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND state IN ('open','complete','incomplete')`,
    [row.route, row.catalogue_id, row.input_id],
  );
  await releaseHold(tx, row.route, row.catalogue_id, row.input_id);
}

/** Capture one current draft identity. The source rows stay in place; only the small header and a native hold are new. */
export async function captureHostedMigrationInput(
  dependencies: HostedMigrationInputDependencies,
  actor: Actor,
  input: HostedMigrationInputCapture,
  context: HostedCommandContext,
) {
  requireAccount(actor);
  const route = routeFor(input.catalogueId);
  if (routeOf(input.expectedRevisionId) !== route)
    throw new InvalidHostedMigrationInputError('Invalid hosted migration source revision');
  const inputId = newId(route);
  const request = { catalogueId: input.catalogueId, expectedRevisionId: input.expectedRevisionId };
  const receipt = {
    kind: CAPTURE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(CAPTURE_KIND, actor, request),
  };
  const admission = await admittedCatalogue(dependencies, actor, input.catalogueId, context, receipt);
  return runCommand<HostedMigrationInputCaptureResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx, { time }) => {
      const catalogue = await hostedCatalogue(tx, input.catalogueId, true);
      if (!catalogue || catalogue.thread_id !== admission.threadId) throw new ContentNotFoundError();
      if (catalogue.head_revision_id !== input.expectedRevisionId) throw new RevisionPreconditionError();
      const revision = (
        await tx.query<RevisionRow>(
          `SELECT kind FROM content.hosted_structure_revision
           WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
          [route, input.catalogueId, input.expectedRevisionId],
        )
      ).rows[0];
      if (!revision || revision.kind !== 'structure') throw new ContentNotFoundError();

      const descriptor = (
        await tx.query<DescriptorRow>(
          `SELECT base_revision_id,base_placement_count::text,base_root_count::text,high_water::text
           FROM content.hosted_append_descriptor
           WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
          [route, input.catalogueId, input.expectedRevisionId],
        )
      ).rows[0];

      let sourceKind: 'snapshot' | 'prefix' = 'snapshot';
      let baseRevisionId = input.expectedRevisionId;
      let basePlacementCount = 0n;
      let baseRootCount = 0n;
      let highWater = -1n;
      if (descriptor) {
        sourceKind = 'prefix';
        baseRevisionId = descriptor.base_revision_id;
        basePlacementCount = BigInt(descriptor.base_placement_count);
        baseRootCount = BigInt(descriptor.base_root_count);
        highWater = BigInt(descriptor.high_water);
      } else {
        const lastPlacement = (
          await tx.query<{ ordinal: string }>(
            `SELECT ordinal::text FROM content.hosted_placement
             WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3
             ORDER BY ordinal DESC LIMIT 1`,
            [route, input.catalogueId, input.expectedRevisionId],
          )
        ).rows[0];
        const lastRoot = (
          await tx.query<{ position: string }>(
            `SELECT position::text FROM content.hosted_placement
             WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND parent_id IS NULL
             ORDER BY position DESC LIMIT 1`,
            [route, input.catalogueId, input.expectedRevisionId],
          )
        ).rows[0];
        basePlacementCount = lastPlacement ? BigInt(lastPlacement.ordinal) + 1n : 0n;
        baseRootCount = lastRoot ? BigInt(lastRoot.position) + 1n : 0n;
      }
      const expectedCount = basePlacementCount + (highWater < 0n ? 0n : highWater + 1n);
      const maximum = BigInt(Number.MAX_SAFE_INTEGER);
      if (expectedCount > maximum || basePlacementCount > maximum || baseRootCount > maximum)
        throw new InvalidHostedMigrationInputError('Hosted migration source exceeds its exact address range');
      const expiry = expiresAt(time);
      await tx.query(
        `INSERT INTO content.hosted_migration_input
         (route,catalogue_id,input_id,owner_account_id,source_revision_id,source_kind,base_revision_id,
          base_placement_count,base_root_count,source_high_water,expected_placement_count,frontier_segment,
          after_ordinal,after_offset,raw_visited,coverage_complete,state,expires_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'base',-1,-1,0,false,'open',$12,$13,$13)`,
        [
          route,
          input.catalogueId,
          inputId,
          actor.accountId,
          input.expectedRevisionId,
          sourceKind,
          baseRevisionId,
          basePlacementCount.toString(),
          baseRootCount.toString(),
          highWater.toString(),
          expectedCount.toString(),
          expiry,
          authoritativeTimeValue(time),
        ],
      );
      await tx.query(
        `INSERT INTO content.hosted_migration_input_reference
         (route,catalogue_id,input_id,source_revision_id,base_revision_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [route, input.catalogueId, inputId, input.expectedRevisionId, baseRevisionId],
      );
      const row: InputRow = {
        route,
        catalogue_id: input.catalogueId,
        input_id: inputId,
        owner_account_id: actor.accountId,
        source_revision_id: input.expectedRevisionId,
        source_kind: sourceKind,
        base_revision_id: baseRevisionId,
        base_placement_count: basePlacementCount.toString(),
        base_root_count: baseRootCount.toString(),
        source_high_water: highWater.toString(),
        expected_placement_count: expectedCount.toString(),
        frontier_segment: 'base',
        after_ordinal: '-1',
        after_offset: '-1',
        raw_visited: '0',
        coverage_complete: false,
        state: 'open',
        expires_at: expiry,
      };
      return noEffect({
        inputId,
        source: sourceIdentity(row),
        frontier: { segment: 'base', afterOrdinal: -1 },
        expiresAt: expiry,
      });
    },
  );
}

async function readNextInterval(
  tx: CommandTransaction,
  row: InputRow,
  start: HostedMigrationFrontier,
  limit: number,
): Promise<Readonly<{ end: HostedMigrationFrontier; count: number; exhausted: boolean }>> {
  const selected: Array<{ segment: 'base'; key: string } | { segment: 'prefix'; key: string }> = [];
  const sourceKind = row.source_kind;
  const highWater = BigInt(row.source_high_water);
  let end = start;
  let exhausted = false;

  if (start.segment === 'complete') return { end: start, count: 0, exhausted: true };
  if (start.segment === 'base') {
    const base = await selectBaseKeys(
      tx,
      row.route,
      row.catalogue_id,
      row.base_revision_id,
      String(start.afterOrdinal),
      limit + 1,
    );
    if (base.length > limit) {
      const page = base.slice(0, limit);
      for (const item of page) selected.push({ segment: 'base', key: item.ordinal });
      end = { segment: 'base', afterOrdinal: Number(page.at(-1)!.ordinal) };
    } else {
      for (const item of base) selected.push({ segment: 'base', key: item.ordinal });
      if (sourceKind === 'snapshot' || highWater < 0n) {
        end = { segment: 'complete' };
        exhausted = true;
      } else if (selected.length === limit) {
        end = { segment: 'prefix', afterOffset: '-1' };
      } else {
        const remaining = limit - selected.length;
        const prefix = await selectPrefixKeys(
          tx,
          row.route,
          row.catalogue_id,
          row.base_revision_id,
          '-1',
          row.source_high_water,
          remaining + 1,
        );
        const page = prefix.slice(0, remaining);
        for (const item of page) selected.push({ segment: 'prefix', key: item.append_offset });
        if (prefix.length > remaining) end = { segment: 'prefix', afterOffset: page.at(-1)!.append_offset };
        else {
          end = { segment: 'complete' };
          exhausted = true;
        }
      }
    }
  } else {
    const prefix = await selectPrefixKeys(
      tx,
      row.route,
      row.catalogue_id,
      row.base_revision_id,
      start.afterOffset,
      row.source_high_water,
      limit + 1,
    );
    const page = prefix.slice(0, limit);
    for (const item of page) selected.push({ segment: 'prefix', key: item.append_offset });
    if (prefix.length > limit) end = { segment: 'prefix', afterOffset: page.at(-1)!.append_offset };
    else {
      end = { segment: 'complete' };
      exhausted = true;
    }
  }

  return { end, count: selected.length, exhausted };
}

async function commitPage(
  tx: CommandTransaction,
  row: InputRow,
  start: HostedMigrationFrontier,
  limit: number,
): Promise<PageCommit> {
  const interval = await readNextInterval(tx, row, start, limit);
  const visited = BigInt(row.raw_visited) + BigInt(interval.count);
  const expected = BigInt(row.expected_placement_count);
  const coverageComplete = interval.exhausted && visited === expected;
  const state: HostedMigrationInputStatus = interval.exhausted
    ? coverageComplete
      ? 'complete'
      : 'incomplete'
    : 'open';
  const nextFrontier = interval.end;
  const savedAfterOrdinal = nextFrontier.segment === 'base' ? String(nextFrontier.afterOrdinal) : row.after_ordinal;
  const savedAfterOffset = nextFrontier.segment === 'prefix' ? nextFrontier.afterOffset : row.after_offset;
  await tx.query(
    `UPDATE content.hosted_migration_input SET frontier_segment=$4,after_ordinal=$5::bigint,
       after_offset=$6::bigint,raw_visited=$7::bigint,coverage_complete=$8,state=$9,updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
    [
      row.route,
      row.catalogue_id,
      row.input_id,
      nextFrontier.segment,
      savedAfterOrdinal,
      savedAfterOffset,
      visited.toString(),
      coverageComplete,
      state,
    ],
  );
  return {
    inputId: row.input_id,
    source: sourceIdentity(row),
    status: state,
    frontier: nextFrontier,
    visited: visited.toString(),
    complete: coverageComplete,
    interval: { start, end: nextFrontier, count: String(interval.count) },
  };
}

/** Commit one keyset interval and its continuation together. Replaying the command returns only this bounded locator interval. */
export async function advanceHostedMigrationInput(
  dependencies: HostedMigrationInputDependencies,
  actor: Actor,
  catalogueId: string,
  inputId: string,
  page: HostedMigrationInputPage,
  context: HostedCommandContext,
) {
  requireAccount(actor);
  const route = routeFor(catalogueId, inputId);
  const limit = page.limit ?? HOSTED_MIGRATION_INPUT_PAGE_MAX;
  if (!Number.isInteger(limit) || limit < 1 || limit > HOSTED_MIGRATION_INPUT_PAGE_MAX)
    throw new InvalidHostedMigrationInputError('Hosted migration page size is outside its bound');
  const receiptInput = { catalogueId, inputId, frontier: page.frontier, limit };
  const receipt = {
    kind: PAGE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(PAGE_KIND, actor, receiptInput),
  };
  const admission = await admittedCatalogue(dependencies, actor, catalogueId, context, receipt);
  const committed = await runCommand<PageCommit>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx, { time }) => {
      const row = await loadInput(tx, route, catalogueId, inputId, true);
      if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
      const source = sourceIdentity(row);
      const savedFrontier = frontier(row);
      assertFrontier(page.frontier, row);
      if (row.state === 'open' || row.state === 'complete' || row.state === 'incomplete') {
        if (expiresOn(row) <= Date.parse(authoritativeTimeValue(time))) {
          await expireInput(tx, row);
          const expired: PageCommit = {
            inputId,
            source,
            status: 'expired',
            frontier: savedFrontier,
            visited: row.raw_visited,
            complete: false,
            interval: null,
          };
          return noEffect(expired);
        }
      }
      if (row.state !== 'open') {
        return noEffect({
          inputId,
          source,
          status: row.state,
          frontier: savedFrontier,
          visited: row.raw_visited,
          complete: row.coverage_complete,
          interval: null,
        });
      }
      if (!sameFrontier(page.frontier, savedFrontier)) throw new RevisionPreconditionError();
      const result = await commitPage(tx, row, savedFrontier, limit);
      return noEffect(result);
    },
  );
  return readCommittedPage(dependencies, actor, catalogueId, inputId, committed.value, context);
}

function intervalAfter(frontierValue: HostedMigrationFrontier): string {
  return frontierValue.segment === 'base' ? String(frontierValue.afterOrdinal) : '-1';
}

async function selectBaseEntries(
  tx: CommandTransaction,
  source: HostedMigrationSourceIdentity,
  start: HostedMigrationFrontier,
  end: HostedMigrationFrontier,
  limit: number,
) {
  if (start.segment !== 'base' || end.segment === 'base') {
    if (start.segment !== 'base') return [] as BaseEntryRow[];
  }
  const after = intervalAfter(start);
  const maximum = end.segment === 'base' ? ` AND p.ordinal<=$5::bigint` : '';
  const values = [routeOf(source.catalogueId), source.catalogueId, source.baseRevisionId, after];
  if (end.segment === 'base') values.push(String(end.afterOrdinal));
  values.push(String(limit));
  const limitParameter = end.segment === 'base' ? '$6' : '$5';
  return (
    await tx.query<BaseEntryRow>(
      `SELECT p.ordinal::text,p.occurrence_id,p.parent_id,p.position,p.title,p.title_redacted,o.kind,
              o.thread_id,o.post_id,p.target_revision_id,encode(p.body_sha256,'hex') AS sha256
       FROM content.hosted_placement p
       JOIN content.hosted_occurrence o
         ON o.route=p.route AND o.catalogue_id=p.catalogue_id AND o.occurrence_id=p.occurrence_id
       WHERE p.route=$1 AND p.catalogue_id=$2 AND p.revision_id=$3 AND p.ordinal>$4::bigint${maximum}
       ORDER BY p.ordinal LIMIT ${limitParameter}`,
      values,
    )
  ).rows;
}

async function selectPrefixEntries(
  tx: CommandTransaction,
  source: HostedMigrationSourceIdentity,
  start: HostedMigrationFrontier,
  end: HostedMigrationFrontier,
  limit: number,
) {
  if (source.kind !== 'prefix' || end.segment === 'base' || start.segment === 'complete') return [] as PrefixEntryRow[];
  const after = start.segment === 'prefix' ? start.afterOffset : '-1';
  const upper = end.segment === 'prefix' ? end.afterOffset : source.highWater;
  return (
    await tx.query<PrefixEntryRow>(
      `SELECT a.append_offset::text,a.occurrence_id,a.title,a.title_redacted,o.kind,o.thread_id,o.post_id,
              a.target_revision_id,encode(a.body_sha256,'hex') AS sha256
       FROM content.hosted_append a
       JOIN content.hosted_occurrence o
         ON o.route=a.route AND o.catalogue_id=a.catalogue_id AND o.occurrence_id=a.occurrence_id
       WHERE a.route=$1 AND a.catalogue_id=$2 AND a.stream_id=$3
         AND a.append_offset>$4::bigint AND a.append_offset<=$5::bigint
       ORDER BY a.append_offset LIMIT $6`,
      [routeOf(source.catalogueId), source.catalogueId, source.baseRevisionId, after, upper, limit],
    )
  ).rows;
}

function availableTitle(title: string | null, redacted: boolean): title is string {
  return !redacted && title !== null;
}

function baseEntry(row: BaseEntryRow, source: HostedMigrationSourceIdentity): HostedMigrationEntry {
  const common = {
    address: { segment: 'base' as const, revisionId: source.baseRevisionId, ordinal: Number(row.ordinal) },
    occurrenceId: row.occurrence_id,
    parentId: row.parent_id,
    position: row.position,
    ordinal: Number(row.ordinal),
  };
  if (row.kind === 'part')
    return availableTitle(row.title, row.title_redacted)
      ? { ...common, availability: 'available', kind: 'part', title: row.title }
      : { ...common, availability: 'unavailable', kind: 'part' };
  const target = {
    threadId: row.thread_id!,
    postId: row.post_id!,
    revisionId: row.target_revision_id!,
    sha256: row.sha256!,
  };
  return availableTitle(row.title, row.title_redacted)
    ? { ...common, availability: 'available', kind: 'chapter', title: row.title, target }
    : { ...common, availability: 'unavailable', kind: 'chapter' };
}

function prefixEntry(row: PrefixEntryRow, source: HostedMigrationSourceIdentity): HostedMigrationEntry {
  const offset = BigInt(row.append_offset);
  const common = {
    address: { segment: 'prefix' as const, streamId: source.baseRevisionId, offset: row.append_offset },
    occurrenceId: row.occurrence_id,
    parentId: null,
    position: Number(BigInt(source.baseRootCount) + offset),
    ordinal: Number(BigInt(source.basePlacementCount) + offset),
  };
  if (row.kind !== 'chapter') throw new Error('Hosted append source contains a non-chapter occurrence');
  const target = {
    threadId: row.thread_id!,
    postId: row.post_id!,
    revisionId: row.target_revision_id!,
    sha256: row.sha256!,
  };
  return availableTitle(row.title, row.title_redacted)
    ? { ...common, availability: 'available', kind: 'chapter', title: row.title, target }
    : { ...common, availability: 'unavailable', kind: 'chapter' };
}

async function readCommittedPage(
  dependencies: HostedMigrationInputDependencies,
  actor: Actor,
  catalogueId: string,
  inputId: string,
  committed: PageCommit,
  context: HostedCommandContext,
): Promise<HostedMigrationInputPageResult> {
  const route = routeFor(catalogueId, inputId);
  const request = { catalogueId, inputId, committed };
  const readReceipt = {
    kind: PAGE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(`${PAGE_KIND}.read`, actor, request),
  };
  const admission = await admittedCatalogue(dependencies, actor, catalogueId, context, readReceipt);
  const read = await runCommand<HostedMigrationInputPageResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      authorization: admission.authorization,
    },
    async (tx, { time }) => {
      const row = await loadInput(tx, route, catalogueId, inputId, true);
      if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
      let status = row.state;
      if (
        (status === 'open' || status === 'complete' || status === 'incomplete') &&
        expiresOn(row) <= Date.parse(authoritativeTimeValue(time))
      ) {
        await expireInput(tx, row);
        status = 'expired';
      }
      const source = sourceIdentity(row);
      const current = (
        await tx.query<{ head_revision_id: string }>(
          `SELECT head_revision_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
          [route, catalogueId],
        )
      ).rows[0];
      const active = status === 'open' || status === 'complete' || status === 'incomplete';
      let entries: HostedMigrationEntry[] = [];
      if (
        committed.interval &&
        (status === 'open' || status === 'complete' || status === 'incomplete') &&
        expiresOn(row) > Date.parse(authoritativeTimeValue(time))
      ) {
        const count = Number(BigInt(committed.interval.count));
        if (count > HOSTED_MIGRATION_INPUT_PAGE_MAX) throw new HostedMigrationInputUnavailableError();
        const base = await selectBaseEntries(tx, source, committed.interval.start, committed.interval.end, count + 1);
        const prefix = await selectPrefixEntries(
          tx,
          source,
          committed.interval.start,
          committed.interval.end,
          count + 1,
        );
        if (base.length + prefix.length !== count) throw new HostedMigrationInputUnavailableError();
        entries = [...base.map((item) => baseEntry(item, source)), ...prefix.map((item) => prefixEntry(item, source))];
      }
      return noEffect({
        inputId,
        status: active ? committed.status : status,
        source,
        sourceCurrent: current?.head_revision_id === source.revisionId,
        frontier: active ? committed.frontier : frontier(row),
        coverage: {
          visited: active ? committed.visited : row.raw_visited,
          expected: row.expected_placement_count,
          complete: active ? committed.complete : row.coverage_complete && status !== 'source_erased',
        },
        items: entries,
      });
    },
  );
  const result = read.value;
  const items: HostedMigrationEntry[] = [];
  for (const item of result.items) {
    if (item.kind !== 'chapter' || item.availability !== 'available') {
      items.push(item);
      continue;
    }
    const disclosed = await discloseHostedTargetMetadata(dependencies, item.target, {
      actor,
      deadline: context.deadline,
    });
    if (disclosed) {
      items.push(item);
    } else {
      items.push({
        address: item.address,
        occurrenceId: item.occurrenceId,
        parentId: item.parentId,
        position: item.position,
        ordinal: item.ordinal,
        availability: 'unavailable',
        kind: 'chapter',
      });
    }
  }

  const finalAdmission = await admittedCatalogue(dependencies, actor, catalogueId, context, readReceipt);
  const final = await runCommand<HostedMigrationInputPageResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      authorization: finalAdmission.authorization,
    },
    async (tx, { time }) => {
      const row = await loadInput(tx, route, catalogueId, inputId, true);
      if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
      let status = row.state;
      if (
        (status === 'open' || status === 'complete' || status === 'incomplete') &&
        expiresOn(row) <= Date.parse(authoritativeTimeValue(time))
      ) {
        await expireInput(tx, row);
        status = 'expired';
      }
      const current = (
        await tx.query<{ head_revision_id: string }>(
          `SELECT head_revision_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2`,
          [route, catalogueId],
        )
      ).rows[0];
      const active = status === 'open' || status === 'complete' || status === 'incomplete';
      return noEffect({
        inputId,
        status: active ? committed.status : status,
        source: sourceIdentity(row),
        sourceCurrent: current?.head_revision_id === row.source_revision_id,
        frontier: active ? committed.frontier : frontier(row),
        coverage: {
          visited: active ? committed.visited : row.raw_visited,
          expected: row.expected_placement_count,
          complete: active ? committed.complete : row.coverage_complete && status !== 'source_erased',
        },
        items: [],
      });
    },
  );
  const finalValue = final.value;
  const stillAvailable = ['open', 'complete', 'incomplete'].includes(finalValue.status);
  return {
    ...result,
    status: finalValue.status,
    source: finalValue.source,
    sourceCurrent: finalValue.sourceCurrent,
    frontier: finalValue.frontier,
    coverage: finalValue.coverage,
    items: stillAvailable ? items : [],
  };
}

/** Release a single input hold. Checkpoints and shared source rows are retained. */
export async function releaseHostedMigrationInput(
  dependencies: HostedMigrationInputDependencies,
  actor: Actor,
  catalogueId: string,
  inputId: string,
  request: HostedMigrationInputRelease,
  context: HostedCommandContext,
) {
  requireAccount(actor);
  const route = routeFor(catalogueId, inputId);
  const receipt = {
    kind: RELEASE_KIND,
    key: context.idempotencyKey,
    digest: requestDigest(RELEASE_KIND, actor, { catalogueId, inputId, request }),
  };
  const admission = await admittedCatalogue(dependencies, actor, catalogueId, context, receipt);
  return runCommand<HostedMigrationInputReleaseResult>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization: admission.authorization,
    },
    async (tx, { time }) => {
      const row = await loadInput(tx, route, catalogueId, inputId, true);
      if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
      const now = Date.parse(authoritativeTimeValue(time));
      let state = row.state;
      if (request.disposition === 'consumed') {
        if (state !== 'consumed' && (state !== 'complete' || !row.coverage_complete))
          throw new HostedMigrationInputIncompleteError();
        state = 'consumed';
      } else if (request.disposition === 'expired') {
        if (now < expiresOn(row)) throw new InvalidHostedMigrationInputError('Hosted migration input has not expired');
        if (state === 'open' || state === 'complete' || state === 'incomplete') state = 'expired';
      } else if (state === 'open' || state === 'complete' || state === 'incomplete') state = 'cancelled';

      if (state !== row.state) {
        await tx.query(
          `UPDATE content.hosted_migration_input SET state=$4,updated_at=transaction_timestamp()
           WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
          [route, catalogueId, inputId, state],
        );
        await releaseHold(tx, route, catalogueId, inputId);
      }
      return noEffect({
        inputId,
        status: state,
        source: sourceIdentity(row),
        coverage: {
          visited: row.raw_visited,
          expected: row.expected_placement_count,
          complete: row.coverage_complete && state !== 'source_erased',
        },
      });
    },
  );
}
