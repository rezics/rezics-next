import { createReleasedRelationDirectionResolver, releaseDigest, type Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { CreditSearchQualifier } from '../search/credit-search.ts';
import { readRelease } from './definitions.ts';
import { withoutFencedEntries } from './fences.ts';
import { workCreditProperties } from './list-presentation-work-context.ts';
import { indexedStatement } from './scope-leaf-selection.ts';
import {
  ZERO_UUID,
  installedLimits,
  isRecord,
  observationOf,
  sortQualifiers,
  type CreditCursor,
  type CreditSearchCeilings,
  type WorkCut,
  type WorkHeader,
} from './credit-search-cut.ts';
import readSubjects from './search-source-subjects.sql';
import readReleases from './search-source-releases.sql';
import rebuildSelection from './search-selected-rebuild.sql';
import readCreditPage from './credit-search-page.sql';
import readCreditStatement from './credit-search-statement.sql';

export type SelectedCredit = {
  route: number;
  subject_id: string;
  slot_id: string;
  candidate_id: string;
  property: string;
  rank: 'normal' | 'preferred';
  ordinal: number;
  revision: number;
  body: unknown;
  release: string;
  source: unknown;
  relation: boolean;
  compact: boolean;
  eligible: boolean | null;
};

export type ParsedCredit = Readonly<{
  row: SelectedCredit;
  targetId: string;
  qualifiers: readonly CreditSearchQualifier[];
  overflowQualifiers: boolean;
}>;

export type CreditPlan = {
  properties: readonly string[];
  releases: Map<string, Release>;
};

export async function inCreditSnapshot<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection(client, rollbackError as Error);
      }
      throw error;
    }
  });
}

export async function readCanonicalGeneration(client: Pool | PoolClient): Promise<string> {
  const result = await client.query<{ last_value: string; is_called: boolean }>(
    `SELECT last_value::text,is_called FROM semantic.search_canonical_generation`,
  );
  const row = result.rows[0];
  if (!row || !/^[0-9]+$/.test(row.last_value)) throw new Error('Search canonical generation is unavailable');
  return `${row.last_value}:${row.is_called ? 1 : 0}`;
}

export async function loadReleases(client: PoolClient, digests: readonly string[]): Promise<Map<string, Release>> {
  const unique = [...new Set(digests)];
  if (!unique.length) return new Map();
  const rows = (await readReleases.run(client, { route: 0, digests: unique })) as {
    digest: string;
    body: Release;
  }[];
  const releases = new Map(rows.map((row) => [row.digest, row.body]));
  for (const digest of unique) {
    if (releases.has(digest)) continue;
    const composed = await readRelease(client, digest);
    if (composed) releases.set(digest, composed);
  }
  return releases;
}

export async function workCut(pool: Pool, workId: string): Promise<WorkCut | 'unavailable' | 'moved'> {
  const route = routeOf(workId);
  if (route === null) return 'unavailable';
  const partition = partitionOf(route);
  return inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home) return 'unavailable';
    if (home.writeState === 'moved') return 'moved';
    const generation = await readCanonicalGeneration(client);
    const rows = (await readSubjects.run(client, {
      partition_no: partition,
      routes: [route],
      subject_ids: [workId],
    })) as WorkHeader[];
    const work = rows[0];
    if (!work) return 'unavailable';
    return { work, generation, ready: work.selection_ready && work.current_revision !== null };
  });
}

export async function resumeSelection(pool: Pool, work: WorkHeader): Promise<void> {
  await rebuildSelection.run(pool, { route: work.route, subject_id: work.id });
}

export async function creditPlan(pool: Pool, work: WorkHeader): Promise<CreditPlan | 'unsupported'> {
  const digest = work.currentRelease;
  if (!digest) return 'unsupported';
  const releases = await inCreditSnapshot(pool, async (client) => loadReleases(client, [digest]));
  const release = releases.get(digest);
  if (!release) return 'unsupported';
  const properties = workCreditProperties(
    release,
    work.type,
    createReleasedRelationDirectionResolver(release, releaseDigest(release)),
  );
  if (!properties.length) return 'unsupported';
  return { properties, releases };
}

export async function selectedCredits(
  pool: Pool,
  work: WorkHeader,
  properties: readonly string[],
  after: CreditCursor | null,
  limit: number,
): Promise<SelectedCredit[]> {
  if (!properties.length || limit < 1) return [];
  const partition = partitionOf(work.route);
  return inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home || home.writeState === 'moved') return [];
    return (await readCreditPage.run(client, {
      partition_no: partition,
      route: work.route,
      subject_id: work.id,
      properties: [...properties],
      has_after: after !== null,
      after_property: after?.property ?? '',
      after_slot: after?.slot ?? ZERO_UUID,
      after_candidate: after?.candidate ?? ZERO_UUID,
      page_limit: limit,
    })) as SelectedCredit[];
  });
}

export async function exactCredit(
  pool: Pool,
  work: WorkHeader,
  property: string,
  statementId: string,
): Promise<SelectedCredit | undefined> {
  const partition = partitionOf(work.route);
  const rows = await inCreditSnapshot(pool, async (client) => {
    const home = await readPartition(client, partition);
    if (!home || home.writeState === 'moved') return [];
    return (await readCreditStatement.run(client, {
      partition_no: partition,
      route: work.route,
      subject_id: work.id,
      property,
      candidate_id: statementId,
    })) as SelectedCredit[];
  });
  return rows.length === 1 ? rows[0] : undefined;
}

export async function discloseCredits(
  pool: Pool,
  routeKey: Uint8Array | undefined,
  rows: readonly SelectedCredit[],
): Promise<SelectedCredit[]> {
  if (!routeKey || !rows.length) return [...rows];
  return inCreditSnapshot(pool, async (client) =>
    withoutFencedEntries(
      client,
      routeKey,
      rows.map((row) => ({
        ...row,
        candidate_id: row.candidate_id,
        subject_id: row.subject_id,
      })),
    ),
  );
}

export function parseCredit(row: SelectedCredit, release: Release, qualifiersPerCredit: number): ParsedCredit | null {
  if (row.eligible !== true || !isRecord(row.body)) return null;
  const statement = indexedStatement(row, release);
  if (!statement || release.properties[row.property]?.datatype !== 'wikibase-item') return null;
  if (routeOf(statement.value) === null) return null;
  const rawQualifiers = Array.isArray(row.body.qualifiers) ? row.body.qualifiers : [];
  const overflowQualifiers = rawQualifiers.length > qualifiersPerCredit;
  const qualifiers = overflowQualifiers
    ? []
    : sortQualifiers(
        (statement.qualifiers ?? []).map((qualifier) => ({ property: qualifier.property, value: qualifier.value })),
      );
  if (!overflowQualifiers && qualifiers.length > qualifiersPerCredit) return null;
  return { row, targetId: statement.value, qualifiers, overflowQualifiers };
}

export async function parsePage(
  pool: Pool,
  work: WorkHeader,
  rows: readonly SelectedCredit[],
  plan: CreditPlan,
  limits: CreditSearchCeilings,
): Promise<ParsedCredit[]> {
  const digests = [...new Set(rows.map((row) => row.release).filter((digest) => !plan.releases.has(digest)))];
  if (digests.length) {
    const extra = await inCreditSnapshot(pool, async (client) => loadReleases(client, digests));
    for (const [digest, release] of extra) plan.releases.set(digest, release);
  }
  const admitted = new Set(plan.properties);
  const parsed: ParsedCredit[] = [];
  for (const row of rows) {
    if (!admitted.has(row.property)) continue;
    const release = plan.releases.get(row.release) ?? plan.releases.get(work.currentRelease ?? '');
    if (!release) continue;
    const credit = parseCredit(row, release, limits.qualifiersPerCredit);
    if (credit) parsed.push(credit);
  }
  return parsed;
}

export function publicWorkCut(cut: WorkCut): boolean {
  return cut.work.visibility === 'visible' && !cut.work.redirect && cut.ready;
}

export function currentObservation(cut: WorkCut, observation: string): boolean {
  return publicWorkCut(cut) && observationOf(cut) === observation;
}

export { installedLimits, observationOf };
