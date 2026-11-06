import { createHash } from 'node:crypto';
import {
  IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS,
  IDENTITY_RATING_REVIEW_MAX_KEYS,
} from '../identity-core/rating-review-bounds.ts';
import {
  classifyIdentityMappings,
  classifyIdentityRatingReviewEvidence as classifyRatingReview,
  comparableIdentityEvidence,
  identityRatingReviewEvidence,
  type IdentityMappingEvidence,
  type IdentityOwnerEvidence,
  type IdentitySourceEvidence,
  type IdentityPendingEvidence,
  type IdentityControlEvidence,
  type IdentityMappingRequest,
  type IdentityRatingControlLocator,
  type IdentityRatingNativeEvidence,
  type IdentityRatingReviewOperand,
  type IdentityRatingReviewResult,
  type IdentityRatingReviewUnavailableReason,
  type IdentityRatingSubjectDisclosure,
} from '../identity-core/index.ts';
import type { Pool, PoolClient } from 'pg';
import { partitionOf, routeOf } from '../../route/route.ts';
import {
  CommandUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
  withReadTransaction,
  withRequestDeadline,
} from '../read.ts';
import type { IdentityMapping } from './identity-epoch-contract.ts';
import owners from '../identity-epoch-read-owners.sql';
import sources from '../identity-epoch-read-sources.sql';
import pending from '../identity-epoch-read-pending.sql';
import current from '../identity-terminal-closure-current.sql';
import disclosure from '../identity-epoch-read-review-disclosure.sql';
import { identitySourceSupportJob } from '../identity-source-support-scope.ts';

export type {
  IdentityRatingControlLocator,
  IdentityRatingReviewOperand,
  IdentityRatingReviewResult,
  IdentityRatingReviewUnavailableReason,
  IdentityRatingNativeEvidence,
};
type SubjectDisclosure = IdentityRatingSubjectDisclosure;

type Queryable = Readonly<{
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}>;

function sortedEvidence(value: IdentityMappingEvidence): IdentityMappingEvidence {
  return {
    sourceOwners: [...value.sourceOwners].sort((left, right) => left.partition_no - right.partition_no),
    sourceRows: [...value.sourceRows].sort((left, right) => left.subject_id.localeCompare(right.subject_id)),
    controlOwners: [...value.controlOwners].sort((left, right) => left.partition_no - right.partition_no),
    pendingRows: [...value.pendingRows].sort(
      (left, right) => left.partition_no - right.partition_no || left.terminal.localeCompare(right.terminal),
    ),
    currentRows: [...value.currentRows].sort(
      (left, right) =>
        left.partition_no - right.partition_no ||
        left.terminal.localeCompare(right.terminal) ||
        left.requested_original.localeCompare(right.requested_original),
    ),
  };
}

function controlLocatorsOf(sourceRows: readonly IdentitySourceEvidence[]): IdentityRatingControlLocator[] {
  const ordered = sourceRows
    .filter((row) => row.control_partition !== null && row.control_group !== null)
    .map((row) => ({ partition: row.control_partition!, group: row.control_group! }))
    .sort((left, right) => left.partition - right.partition || left.group.localeCompare(right.group));
  const result: IdentityRatingControlLocator[] = [];
  for (const locator of ordered) {
    const prior = result.at(-1);
    if (!prior || prior.partition !== locator.partition || prior.group !== locator.group) result.push(locator);
  }
  return result;
}

function selectedSourceEvidence(row: Record<string, unknown>): IdentitySourceEvidence {
  return {
    subject_id: row.subject_id as string,
    original: row.original as string | null,
    control_partition: row.control_partition as number | null,
    control_group: row.control_group as string | null,
    epoch: row.epoch as string | number | bigint,
    owner_epoch: row.owner_epoch as number,
    dirty_revision: row.dirty_revision as string | number | bigint,
    captured_revision: row.captured_revision as string | number | bigint,
    terminal: row.terminal as string,
    closure_state: row.closure_state as string,
    closure_immediate: row.closure_immediate as string | null,
    current_target: row.current_target as string | null,
    source_revision: row.source_revision as string | number | bigint,
    closure_enrollment: row.closure_enrollment as string | null,
    closure_generation: row.closure_generation as string | null,
    closure_incarnation: row.closure_incarnation as string | null,
    closure_install_transaction: row.closure_install_transaction as string | null,
    closure_registration_transaction: row.closure_registration_transaction as string | null,
    closure_export_transaction: row.closure_export_transaction as string | null,
  };
}

function sortSubjects(rows: readonly SubjectDisclosure[]): SubjectDisclosure[] {
  return [...rows].sort((left, right) => left.subject_id.localeCompare(right.subject_id));
}

export { identityRatingReviewEvidence };

function requestsFor(sourceIdentities: readonly string[], routes: readonly number[]): IdentityMappingRequest[] {
  return sourceIdentities.map((original, index) => ({ original, sourceHome: partitionOf(routes[index]!) }));
}

async function sourcePhase(
  client: Queryable,
  sourceIdentities: readonly string[],
  routes: readonly number[],
  home: number,
) {
  const indices = routes.flatMap((route, index) => (partitionOf(route) === home ? [index] : []));
  const ownerResult = await client.query(owners.sql, [[home]]);
  const sourceResult = await client.query(sources.sql, [
    indices.map((index) => sourceIdentities[index]),
    indices.map((index) => routes[index]),
  ]);
  const disclosureResult = await client.query(disclosure.sql, [
    indices.map((index) => sourceIdentities[index]),
    indices.map((index) => routes[index]),
  ]);
  return {
    owners: ownerResult.rows as unknown as IdentityOwnerEvidence[],
    sources: sourceResult.rows.map(selectedSourceEvidence),
    subjects: disclosureResult.rows as unknown as SubjectDisclosure[],
  };
}

async function controlPhase(
  client: Queryable,
  locators: readonly IdentityRatingControlLocator[],
  sourceRows: readonly IdentitySourceEvidence[],
) {
  if (!locators.length) return { owners: [], pending: [], current: [] };
  const homes = [...new Set(locators.map((row) => row.partition))].sort((a, b) => a - b);
  const ownersRows: IdentityOwnerEvidence[] = [];
  const pendingRows: IdentityPendingEvidence[] = [];
  const currentRows: IdentityControlEvidence[] = [];
  for (const home of homes) {
    const controlKeys = locators.filter((row) => row.partition === home);
    const pairs = sourceRows
      .filter((row) => row.control_partition === home && row.control_group !== null && row.original !== null)
      .map((row) => ({ partition: home, terminal: row.control_group!, original: row.original! }))
      .sort(
        (left, right) => left.terminal.localeCompare(right.terminal) || left.original.localeCompare(right.original),
      );
    const ownerResult = await client.query(owners.sql, [[home]]);
    const pendingResult = await client.query(pending.sql, [
      controlKeys.map(() => home),
      controlKeys.map((row) => row.group),
    ]);
    const currentResult = await client.query(current.sql, [
      pairs.map((row) => row.partition),
      pairs.map((row) => row.terminal),
      pairs.map((row) => row.original),
    ]);
    ownersRows.push(...(ownerResult.rows as unknown as IdentityOwnerEvidence[]));
    pendingRows.push(...(pendingResult.rows as unknown as IdentityPendingEvidence[]));
    currentRows.push(...(currentResult.rows as unknown as IdentityControlEvidence[]));
  }
  return { owners: ownersRows, pending: pendingRows, current: currentRows };
}

function assembleEvidence(
  source: Awaited<ReturnType<typeof sourcePhase>>,
  control: Awaited<ReturnType<typeof controlPhase>>,
): IdentityRatingNativeEvidence {
  const mapping = sortedEvidence({
    sourceOwners: source.owners,
    sourceRows: source.sources,
    controlOwners: control.owners,
    pendingRows: control.pending,
    currentRows: control.current,
  });
  return { mapping, subjects: sortSubjects(source.subjects), controlLocators: controlLocatorsOf(source.sources) };
}

function identityReviewFromEvidence(
  requestedOriginalId: string,
  canonicalTerminalId: string,
  sourceIdentities: readonly string[],
  sourceHomes: readonly number[],
  evidence: IdentityRatingNativeEvidence,
): IdentityRatingReviewResult {
  return classifyRatingReview(
    requestedOriginalId,
    canonicalTerminalId,
    sourceIdentities,
    sourceHomes,
    evidence,
    requestsFor(
      sourceIdentities,
      sourceIdentities.map((id) => routeOf(id)!),
    ),
  );
}

/** Bounded exact reviewed mapping evidence; source/control homes are released independently and double-collected. */
export async function readIdentityRatingReview(
  pool: Pool,
  input: Readonly<{ requestedOriginalId: string; canonicalTerminalId: string; deadline: number }>,
): Promise<IdentityRatingReviewResult> {
  const sourceIdentities =
    input.requestedOriginalId === input.canonicalTerminalId
      ? [input.requestedOriginalId]
      : [input.requestedOriginalId, input.canonicalTerminalId];
  if (sourceIdentities.length > IDENTITY_RATING_REVIEW_MAX_KEYS)
    return { state: 'unavailable', reason: 'control-limit' };
  const routes = sourceIdentities.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Rating identity review requires native routed identities');
    return route;
  });
  const sourceHomes = [...new Set(routes.map(partitionOf))].sort((a, b) => a - b);
  if (sourceHomes.length > IDENTITY_RATING_REVIEW_MAX_KEYS) return { state: 'unavailable', reason: 'control-limit' };
  async function collect(): Promise<IdentityRatingNativeEvidence> {
    const source = {
      owners: [] as IdentityOwnerEvidence[],
      sources: [] as IdentitySourceEvidence[],
      subjects: [] as SubjectDisclosure[],
    };
    for (const home of sourceHomes) {
      const part = await withReadTransaction(
        pool,
        (client) => sourcePhase(client, sourceIdentities, routes, home),
        input.deadline,
      );
      source.owners.push(...part.owners);
      source.sources.push(...part.sources);
      source.subjects.push(...part.subjects);
    }
    const locators = controlLocatorsOf(source.sources);
    if (locators.length > IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS)
      return assembleEvidence(source, { owners: [], pending: [], current: [] });
    const controls = {
      owners: [] as IdentityOwnerEvidence[],
      pending: [] as IdentityPendingEvidence[],
      current: [] as IdentityControlEvidence[],
    };
    for (const home of [...new Set(locators.map((row) => row.partition))].sort((a, b) => a - b)) {
      const part = await withReadTransaction(
        pool,
        (client) =>
          controlPhase(
            client,
            locators.filter((row) => row.partition === home),
            source.sources,
          ),
        input.deadline,
      );
      controls.owners.push(...part.owners);
      controls.pending.push(...part.pending);
      controls.current.push(...part.current);
    }
    return assembleEvidence(source, controls);
  }
  const first = await collect();
  const last = await collect();
  if (identityRatingReviewEvidence(first) !== identityRatingReviewEvidence(last))
    return { state: 'unavailable', reason: 'changed-during-read' };
  return identityReviewFromEvidence(
    input.requestedOriginalId,
    input.canonicalTerminalId,
    sourceIdentities,
    sourceHomes,
    last,
  );
}

/** One bounded reread on the caller's original command connection after its native home lock. */
export async function readIdentityRatingEvidenceInTransaction(
  client: Queryable,
  input: Readonly<{ sourceIdentities: readonly string[]; commandHome: number }>,
): Promise<
  Readonly<{ state: 'ready'; evidence: IdentityRatingNativeEvidence }> | Readonly<{ state: 'foreign-control' }>
> {
  const sourceIdentities = [...input.sourceIdentities];
  if (sourceIdentities.length < 1 || sourceIdentities.length > IDENTITY_RATING_REVIEW_MAX_KEYS)
    throw new RangeError('Identity rating review must contain one or two exact source keys');
  const routes = sourceIdentities.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Rating identity review requires native routed identities');
    if (partitionOf(route) !== input.commandHome) return null;
    return route;
  });
  if (routes.some((route) => route === null)) return { state: 'foreign-control' };
  const exactRoutes = routes as number[];
  const sourceHomes = [...new Set(exactRoutes.map(partitionOf))];
  if (sourceHomes.length !== 1 || sourceHomes[0] !== input.commandHome) return { state: 'foreign-control' };
  const source = await sourcePhase(client, sourceIdentities, exactRoutes, input.commandHome);
  const locators = controlLocatorsOf(source.sources);
  if (
    locators.length > IDENTITY_RATING_REVIEW_MAX_CONTROL_LOCATORS ||
    locators.some((row) => row.partition !== input.commandHome)
  )
    return { state: 'foreign-control' };
  const control = await controlPhase(client, locators, source.sources);
  return { state: 'ready', evidence: assembleEvidence(source, control) };
}

/** Pure classifier reused by the transaction participant after it has acquired the native owner fence. */
export function classifyIdentityRatingReviewEvidence(
  requestedOriginalId: string,
  canonicalTerminalId: string,
  sourceIdentities: readonly string[],
  sourceHomes: readonly number[],
  evidence: IdentityRatingNativeEvidence,
): IdentityRatingReviewResult {
  return identityReviewFromEvidence(requestedOriginalId, canonicalTerminalId, sourceIdentities, sourceHomes, evidence);
}

/** Bounded exact mapping proof, with source and control homes released independently. */
export async function readIdentityMappings(pool: Pool, originals: readonly string[]): Promise<IdentityMapping[]> {
  if (originals.length > 100) throw new RangeError('Identity page must contain at most 100 originals');
  if (!originals.length) return [];
  const routes = originals.map((id) => {
    const route = routeOf(id);
    if (route === null) throw new TypeError('Identity original must be a native routed ID');
    return route;
  });
  // Keep every source/control snapshot local to one home. Double collection
  // detects changes while releasing homes; unrelated partition positions do not
  // invalidate exact mapping evidence.
  async function collect(): Promise<IdentityMappingEvidence> {
    const sourceOwners: IdentityOwnerEvidence[] = [],
      sourceRows: IdentitySourceEvidence[] = [];
    const controlOwners: IdentityOwnerEvidence[] = [],
      pendingRows: IdentityPendingEvidence[] = [],
      currentRows: IdentityControlEvidence[] = [];
    for (const home of new Set(routes.map(partitionOf))) {
      const indices = routes.flatMap((route, index) => (partitionOf(route) === home ? [index] : []));
      await withReadTransaction(pool, async (tx) => {
        sourceOwners.push(...(await tx.query(owners.sql, [[home]])).rows);
        sourceRows.push(
          ...(
            await tx.query(sources.sql, [
              indices.map((index) => originals[index]),
              indices.map((index) => routes[index]),
            ])
          ).rows,
        );
      });
    }
    const available = sourceRows.filter((row) => row.original && row.control_partition !== null && row.control_group);
    for (const home of new Set(available.map((row) => row.control_partition!))) {
      const group = available.filter((row) => row.control_partition === home);
      await withReadTransaction(pool, async (tx) => {
        controlOwners.push(...(await tx.query(owners.sql, [[home]])).rows);
        pendingRows.push(
          ...(await tx.query(pending.sql, [group.map(() => home), group.map((row) => row.control_group)])).rows,
        );
        currentRows.push(
          ...(
            await tx.query(current.sql, [
              group.map(() => home),
              group.map((row) => row.control_group),
              group.map((row) => row.original),
            ])
          ).rows,
        );
      });
    }
    return { sourceOwners, sourceRows, controlOwners, pendingRows, currentRows };
  }
  const first = await collect(),
    last = await collect();
  if (comparableIdentityEvidence(first) !== comparableIdentityEvidence(last))
    return originals.map(() => ({ state: 'unavailable', reason: 'bootstrap' }));
  return classifyIdentityMappings(
    originals.map((original, index) => ({ original, sourceHome: partitionOf(routes[index]!) })),
    last,
    identitySourceSupportJob(),
  );
}

/** Native structural tuple. Generation/pending remain Semantic's identity authority. */
export type HomeIdentity = Readonly<{
  partition: number;
  epoch: number;
  home: string;
  generation: bigint;
  pending: bigint;
}>;
export type IdentityBasis = Readonly<{ digest: string }>;
export type BasisRead = { state: 'ready'; basis: IdentityBasis } | { state: 'not_ready' };

const HOME_SQL = `SELECT p.partition_no, p.epoch, p.node, p.write_state, p.moved_to,
  (COALESCE(g.version_sum, 0) + COALESCE(r.seq_sum, 0))::text AS generation,
  (COALESCE(g.pending_count, 0) + CASE WHEN c.pending_job IS NOT NULL THEN 1 ELSE 0 END)::text AS pending
FROM core.partition p
LEFT JOIN semantic.identity_epoch_control c ON c.partition_no = p.partition_no
LEFT JOIN (
  SELECT partition_no, SUM(version) AS version_sum,
    COUNT(*) FILTER (WHERE pending_job IS NOT NULL) AS pending_count
  FROM semantic.identity_epoch_group GROUP BY partition_no
) g ON g.partition_no = p.partition_no
LEFT JOIN (
  SELECT (route / 16) AS partition_no, SUM(sequence) AS seq_sum
  FROM semantic.redirect GROUP BY route / 16
) r ON r.partition_no = p.partition_no`;

type HomeRow = {
  partition_no: number;
  epoch: number;
  node: string;
  write_state: string;
  moved_to: string | null;
  generation: string;
  pending: string;
};

function homeFrom(row: HomeRow | undefined, partition: number): HomeIdentity {
  if (row?.write_state === 'moved') throw new CommandUnavailableError('moved', partition, row.moved_to);
  if (row?.write_state === 'fenced') throw new CommandUnavailableError('fenced', partition);
  if (!row || row.write_state !== 'active') throw new CommandUnavailableError('deadline', partition);
  return {
    partition,
    epoch: row.epoch,
    home: row.node,
    generation: BigInt(row.generation),
    pending: BigInt(row.pending),
  };
}

export async function readIdentityHome(client: PoolClient, partition: number): Promise<HomeIdentity> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096) throw new RangeError('Invalid identity home');
  const result = await client.query<HomeRow>(`${HOME_SQL} WHERE p.partition_no = $1`, [partition]);
  return homeFrom(result.rows[0], partition);
}

async function readIdentityHomes(client: PoolClient): Promise<readonly HomeIdentity[] | null> {
  const result = await client.query<HomeRow>(
    `${HOME_SQL} WHERE p.partition_no BETWEEN 0 AND 4095 ORDER BY p.partition_no`,
  );
  if (result.rows.length !== 4096) return null;
  const homes: HomeIdentity[] = [];
  for (let partition = 0; partition < 4096; partition++) {
    const row = result.rows[partition];
    if (!row || row.partition_no !== partition || row.write_state !== 'active') return null;
    homes.push({
      partition,
      epoch: row.epoch,
      home: row.node,
      generation: BigInt(row.generation),
      pending: BigInt(row.pending),
    });
  }
  return homes;
}

function tuples(homes: readonly HomeIdentity[]): string {
  const field = (value: string) => `${Buffer.byteLength(value, 'utf8')}:${value}`;
  return (
    field('rezics.identity-basis.v1') +
    homes
      .map((home) =>
        [String(home.partition), String(home.epoch), home.home, home.generation.toString()].map(field).join(''),
      )
      .join('')
  );
}

/** Two released observations, never an Access decision or promise about subsequent writes. */
export async function readIdentityBasis(pool: Pool, options: { deadline: number }): Promise<BasisRead> {
  const { deadline } = options;
  try {
    requireAccessDeadline(deadline);
    const first = await withRequestDeadline(deadline, () => withReadTransaction(pool, readIdentityHomes, deadline));
    requireAccessDeadline(deadline);
    const second = await withRequestDeadline(deadline, () => withReadTransaction(pool, readIdentityHomes, deadline));
    requireAccessDeadline(deadline);
    if (!first || !second || first.some((home) => home.pending !== 0n) || second.some((home) => home.pending !== 0n))
      return { state: 'not_ready' };
    const encoded = tuples(first);
    if (encoded !== tuples(second)) return { state: 'not_ready' };
    requireAccessDeadline(deadline);
    return { state: 'ready', basis: { digest: createHash('sha256').update(encoded, 'utf8').digest('hex') } };
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  }
}
