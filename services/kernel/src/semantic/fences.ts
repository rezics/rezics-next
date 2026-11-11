import provenance from './scope-leaf-selection-provenance.sql';
import type { Source } from '@rezics/definitions/bulk';
import type { Pool, PoolClient } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { ContentImportedFieldGroup, ContentQueryClient } from './contract/domain-ports.ts';
import { importedTupleRouteOf } from './adapters/imported-route.ts';
import { readFences, type SourceFence, type SourceFenceTuple } from '../content/source-fences.ts';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { partitionOf } from '../route/route.ts';
import { deadlineFor } from '../request/deadline.ts';
import { withReadTransaction } from './read.ts';

const FIELD_GROUPS = new Set<ContentImportedFieldGroup>(['facts', 'summary', 'cover']);

/** Account-agent provenance is a current native identity, not an imported source tuple. */
export type AgentSelfSource = Readonly<{ kind: 'agent'; subject: string }>;
export type CandidateSource = Source | AgentSelfSource;

/** A source tuple is taken down. The command must not read its receipt or write. */
export class SourceFencedError extends Error {
  constructor() {
    super('Source tuple is fenced');
    this.name = 'SourceFencedError';
  }
}

/** The tuple's home is read by another command in this batch and is not published yet. */
export class FencePending extends Error {
  constructor() {
    super('Source fence is not published');
    this.name = 'FencePending';
  }
}

export type SourceFencePlan = {
  cache: Map<string, boolean>;
  inside: Map<number, SourceFenceTuple[]>;
  ready: Map<number, Promise<void>>;
  release: Map<number, () => void>;
  reject: Map<number, (error: Error) => void>;
  failed: Map<number, Error>;
  done: Set<number>;
};

export function fenceKey(tuple: Pick<SourceFenceTuple, 'route' | 'source' | 'external_id' | 'field_group'>): string {
  return JSON.stringify([tuple.route, tuple.source, tuple.external_id, tuple.field_group]);
}

/** Subject summary cover custody uses the exact same Content fence reader as other Semantic consumers. */
export function readCurrentSourceFences(
  client: ContentQueryClient,
  tuples: readonly SourceFenceTuple[],
): Promise<readonly SourceFence[]> {
  return readFences(client as unknown as Pick<PoolClient, 'query'>, tuples);
}

export function sourceTuple(routeKey: Uint8Array, source: Source): SourceFenceTuple {
  return {
    route: importedTupleRouteOf()(routeKey, source.source, source.external_id),
    source: source.source,
    external_id: source.external_id,
    field_group: source.field_group,
  };
}

function remember(groups: Map<number, SourceFenceTuple[]>, seen: Set<string>, tuple: SourceFenceTuple): void {
  const key = fenceKey(tuple);
  if (seen.has(key)) return;
  seen.add(key);
  const partition = partitionOf(tuple.route);
  const group = groups.get(partition) ?? [];
  group.push(tuple);
  groups.set(partition, group);
}

/** One read per tuple partition. Same-partition tuples are read inside a command; the rest are anchored first. */
export function prepareFencePlan(
  routeKey: Uint8Array,
  commands: readonly { route: number; source: Source }[],
): { plan: SourceFencePlan; outside: Map<number, SourceFenceTuple[]> } {
  const inside = new Map<number, SourceFenceTuple[]>();
  const outside = new Map<number, SourceFenceTuple[]>();
  const seen = new Set<string>();
  const homes = new Set<number>();
  const deferred: SourceFenceTuple[] = [];
  for (const command of commands) {
    const tuple = sourceTuple(routeKey, command.source);
    if (partitionOf(command.route) === partitionOf(tuple.route)) {
      homes.add(partitionOf(tuple.route));
      remember(inside, seen, tuple);
    } else deferred.push(tuple);
  }
  for (const tuple of deferred) {
    if (homes.has(partitionOf(tuple.route))) remember(inside, seen, tuple);
    else remember(outside, seen, tuple);
  }
  const plan: SourceFencePlan = {
    cache: new Map(),
    inside,
    ready: new Map(),
    release: new Map(),
    reject: new Map(),
    failed: new Map(),
    done: new Set(),
  };
  for (const partition of inside.keys()) {
    let resolve: () => void;
    let reject: (error: Error) => void;
    const ready = new Promise<void>((pass, fail) => {
      resolve = pass;
      reject = fail;
    });
    // A partition with no cross-command waiter must not surface an unhandled rejection.
    ready.catch(() => {});
    plan.ready.set(partition, ready);
    plan.release.set(partition, resolve!);
    plan.reject.set(partition, reject!);
  }
  return { plan, outside };
}

export async function readAnchoredFences(
  pool: Pool,
  partition: number,
  tuples: readonly SourceFenceTuple[],
  deadline = deadlineFor(DEFAULT_REQUEST_DEADLINE_MS),
): Promise<readonly SourceFence[]> {
  return withReadTransaction(
    pool,
    async (client) => readFences(await partitionReadClient(client, partition), tuples),
    deadline,
  );
}

export function rememberFences(plan: SourceFencePlan, fences: readonly SourceFence[]): void {
  for (const fence of fences) plan.cache.set(fenceKey(fence), fence.takenDown);
}

/** Read this command's tuple before the receipt. Same-partition batches share one statement.
 * A command never waits inside its transaction for another partition: the caller retries once
 * that partition's own command has published the read.
 */
export async function enforceSourceFence(
  tx: CommandTransaction,
  plan: SourceFencePlan,
  commandPartition: number,
  tuple: SourceFenceTuple,
): Promise<void> {
  if (plan.inside.has(commandPartition) && !plan.done.has(commandPartition)) {
    const fences = await readFences(tx, plan.inside.get(commandPartition)!);
    rememberFences(plan, fences);
    plan.done.add(commandPartition);
    plan.release.get(commandPartition)?.();
  }
  const home = partitionOf(tuple.route);
  const key = fenceKey(tuple);
  if (!plan.cache.has(key)) {
    const failure = plan.failed.get(home);
    if (failure) throw failure;
    if (plan.inside.has(home) && !plan.done.has(home)) throw new FencePending();
  }
  if (plan.cache.get(key) === true) throw new SourceFencedError();
}

function usable(source: CandidateSource | null): source is Source {
  return (
    source !== null &&
    'field_group' in source &&
    FIELD_GROUPS.has(source.field_group) &&
    typeof source.source === 'string' &&
    typeof source.external_id === 'string'
  );
}

/** Drop ids whose source tuple is taken down. One fence read per tuple partition, capped at 100 tuples. */
export async function fencedIds(
  client: Pick<PoolClient, 'query'>,
  routeKey: Uint8Array,
  rows: readonly { id: string; source: CandidateSource | null }[],
): Promise<Set<string>> {
  const tuples: SourceFenceTuple[] = [];
  const owners = new Map<string, string[]>();
  for (const row of rows) {
    if (!usable(row.source)) continue;
    let tuple: SourceFenceTuple;
    try {
      tuple = sourceTuple(routeKey, row.source);
    } catch {
      continue;
    }
    const key = fenceKey(tuple);
    const ids = owners.get(key);
    if (ids) ids.push(row.id);
    else {
      owners.set(key, [row.id]);
      tuples.push(tuple);
    }
  }
  if (tuples.length === 0) return new Set();
  const byPartition = new Map<number, SourceFenceTuple[]>();
  for (const tuple of tuples) {
    const partition = partitionOf(tuple.route);
    const group = byPartition.get(partition) ?? [];
    group.push(tuple);
    byPartition.set(partition, group);
  }
  const gone = new Set<string>();
  for (const group of byPartition.values()) {
    for (let offset = 0; offset < group.length; offset += 100) {
      const fences = await readFences(client, group.slice(offset, offset + 100));
      for (const fence of fences) {
        if (!fence.takenDown) continue;
        for (const id of owners.get(fenceKey(fence)) ?? []) gone.add(id);
      }
    }
  }
  return gone;
}

type ProvenanceRow = { route: number; subject_id: string; candidate_id: string; slot_id?: string };

/** Point probes for the proposing source of each shown candidate, then the recording revision of a compact fact. */
export async function candidateSources(
  client: Pick<PoolClient, 'query'>,
  entries: readonly ProvenanceRow[],
): Promise<Map<string, CandidateSource | null>> {
  const sources = new Map<string, CandidateSource | null>();
  if (entries.length > 256) throw new TypeError('A source fence read accepts at most 256 ids');
  if (entries.length === 0) return sources;
  const parameters = {
    routes: entries.map((entry) => entry.route),
    subjects: entries.map((entry) => entry.subject_id),
    candidates: entries.map((entry) => entry.candidate_id),
    slots: entries.map((entry) => entry.slot_id ?? null),
    max_bytes: 2147483647,
  };
  const result = await client.query<{
    subject_id: string;
    id: string;
    source: CandidateSource | null;
  }>(
    provenance.sql,
    provenance.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  for (const row of result.rows) sources.set(`${row.subject_id}\n${row.id}`, row.source);
  return sources;
}

export async function withoutFencedEntries<T extends ProvenanceRow>(
  client: Pick<PoolClient, 'query'>,
  routeKey: Uint8Array,
  entries: readonly T[],
): Promise<T[]> {
  if (entries.length === 0) return [];
  const sources = await candidateSources(client, entries);
  const gone = await fencedIds(
    client,
    routeKey,
    entries.map((entry) => ({
      id: entry.candidate_id,
      source: sources.get(`${entry.subject_id}\n${entry.candidate_id}`) ?? null,
    })),
  );
  return entries.filter((entry) => !gone.has(entry.candidate_id));
}
