import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { partitionReadClients } from '../database/read-snapshot.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartitions, type Partition } from '../partition/partition.ts';
import { activeRelease } from './definition-release-read.ts';
import { GLOBAL_SUBJECT_CONTEXT } from './contract/subject-values.ts';
import type { IdentityMapping } from './contract/identity-values.ts';
import {
  SEMANTIC_TITLE_INPUT_MAX_BYTES,
  SEMANTIC_TITLE_INPUT_MAX_ORIGINALS,
  type SemanticTitleInputEntry,
  type SemanticTitleInputs,
} from './contract/title-inputs.ts';
import { readIdentityMappings } from './identity-adapters/read.ts';
import { withReadTransaction } from './read.ts';
import { slotId } from './slots.ts';
import readTitleInputs from './title-inputs-read.sql';

const HOME_COUNT = 4096;
const MAX_HOME_NODE_BYTES = 128;
const MAX_BASIS_METADATA_BYTES = 1_048_576;
const HOME_IDS = Array.from({ length: HOME_COUNT }, (_, index) => index);
const unavailable = { status: 'unavailable' as const };

type Basis = Readonly<{ version: string }>;
type SourceRow = Readonly<{
  id: string;
  labels: unknown;
  original: string | null;
  redirect: string | null;
  revision: string | null;
  labelsComplete: boolean;
}>;

type ObserverDependencies = Readonly<{
  readBasis(deadline: number): Promise<Basis | null>;
  readBatch(subjects: readonly string[], deadline: number): Promise<readonly SemanticTitleInputEntry[] | null>;
  requireDeadline(deadline: number): void;
}>;

function validInputs(subjects: readonly string[], deadline: number): void {
  if (!Array.isArray(subjects) || subjects.length > SEMANTIC_TITLE_INPUT_MAX_ORIGINALS)
    throw new RangeError('Semantic title inputs accept at most 100 originals');
  if (
    new Set(subjects).size !== subjects.length ||
    subjects.some((id) => typeof id !== 'string' || routeOf(id) === null)
  )
    throw new TypeError('Semantic title inputs require exact routed originals');
  if (!Number.isFinite(deadline)) throw new TypeError('Semantic title inputs require a finite deadline');
}

/** Stable, ID-independent digest over every current native home and the active Definitions release. */
export function semanticTitleBasisVersion(
  homes: readonly Partition[],
  release: { digest: string; head: number },
): string | null {
  if (
    homes.length !== HOME_COUNT ||
    typeof release.digest !== 'string' ||
    !release.digest ||
    !Number.isSafeInteger(release.head) ||
    release.head < 1
  )
    return null;
  const digest = createHash('sha256');
  let bytes = 0;
  const field = (value: string): boolean => {
    const size = Buffer.byteLength(value, 'utf8');
    bytes += size + 12;
    if (bytes > MAX_BASIS_METADATA_BYTES) return false;
    digest.update(`${size}:`, 'utf8').update(value, 'utf8');
    return true;
  };
  if (!field('semantic-title-inputs-v1') || !field(release.digest) || !field(String(release.head))) return null;
  for (let index = 0; index < HOME_COUNT; index++) {
    const home = homes[index];
    if (
      !home ||
      home.partitionNo !== index ||
      home.writeState !== 'active' ||
      home.movedTo !== null ||
      !Number.isSafeInteger(home.epoch) ||
      home.epoch < 0 ||
      typeof home.node !== 'string' ||
      !home.node ||
      Buffer.byteLength(home.node, 'utf8') > MAX_HOME_NODE_BYTES ||
      home.position < 0n
    )
      return null;
    if (
      !field(String(home.partitionNo)) ||
      !field(String(home.epoch)) ||
      !field(home.node) ||
      !field(home.writeState) ||
      !field(home.movedTo ?? '') ||
      !field(home.position.toString())
    )
      return null;
  }
  return digest.digest('hex');
}

function labelMap(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.some(([language, label]) => !language || typeof label !== 'string')) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Bind exact originals to their one-hop terminal's visible labels and current source revision. */
export function bindSemanticTitleInputRows(
  originals: readonly string[],
  mappings: readonly IdentityMapping[],
  rows: readonly SourceRow[],
): readonly SemanticTitleInputEntry[] | null {
  if (mappings.length !== originals.length) return null;
  const terminals = mappings.map((mapping) => (mapping.state === 'mapped' ? mapping.terminal : null));
  if (terminals.some((terminal) => terminal === null || routeOf(terminal) === null)) return null;
  const expected = new Set([...originals, ...(terminals as string[])]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length || byId.size !== expected.size || [...expected].some((id) => !byId.has(id)))
    return null;

  const entries: SemanticTitleInputEntry[] = [];
  for (let index = 0; index < originals.length; index++) {
    const subjectId = originals[index]!;
    const mapping = mappings[index]!;
    if (mapping.state !== 'mapped' || mapping.original !== subjectId || mapping.epoch <= 0n) return null;
    const sourceId = mapping.terminal;
    const source = byId.get(sourceId);
    const original = byId.get(subjectId);
    const labels = source && labelMap(source.labels);
    if (
      !source ||
      !original ||
      !labels ||
      !source.labelsComplete ||
      source.redirect !== null ||
      source.revision === null ||
      !/^[1-9][0-9]*$/.test(source.revision) ||
      original.redirect !== (sourceId === subjectId ? null : sourceId)
    )
      return null;
    entries.push({
      subjectId,
      sourceId,
      sourceBasis: `${mapping.epoch.toString()}:${source.revision}`,
      labels,
      originalLanguage: source.original,
    });
  }
  if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > SEMANTIC_TITLE_INPUT_MAX_BYTES) return null;
  return entries;
}

/** Testable orchestration: every native reader returns only after its own read snapshot has closed. */
export function createSemanticTitleInputsObserver(dependencies: ObserverDependencies): SemanticTitleInputs {
  return {
    async observe({ subjects, deadline }) {
      validInputs(subjects, deadline);
      dependencies.requireDeadline(deadline);
      const before = await dependencies.readBasis(deadline);
      dependencies.requireDeadline(deadline);
      if (!before) return unavailable;
      if (subjects.length === 0) {
        const after = await dependencies.readBasis(deadline);
        dependencies.requireDeadline(deadline);
        return after?.version === before.version
          ? { status: 'current', basis: before.version, entries: [] }
          : unavailable;
      }
      const entries = await dependencies.readBatch(subjects, deadline);
      dependencies.requireDeadline(deadline);
      if (!entries || entries.length !== subjects.length) return unavailable;
      const after = await dependencies.readBasis(deadline);
      dependencies.requireDeadline(deadline);
      if (!after || after.version !== before.version) return unavailable;
      return { status: 'current', basis: before.version, entries };
    },
  };
}

async function readNativeTitleBasis(pool: Pool, deadline: number): Promise<Basis | null> {
  return withReadTransaction(
    pool,
    async (client) => {
      requireAccessDeadline(deadline);
      const homes = await readPartitions(client, HOME_IDS);
      const active = await activeRelease(client);
      if (!active) return null;
      const version = semanticTitleBasisVersion(homes, active);
      return version ? { version } : null;
    },
    deadline,
  );
}

async function readNativeTitleBatch(
  pool: Pool,
  originals: readonly string[],
  deadline: number,
): Promise<readonly SemanticTitleInputEntry[] | null> {
  return withReadTransaction(
    pool,
    async (client) => {
      requireAccessDeadline(deadline);
      // This reader preserves Semantic's current pending/bootstrap and one-hop identity rules.
      const mappings = await readIdentityMappings(pool, originals);
      if (mappings.length !== originals.length || mappings.some((mapping) => mapping.state !== 'mapped')) return null;
      const terminalIds = mappings.map(
        (mapping) => (mapping as Extract<IdentityMapping, { state: 'mapped' }>).terminal,
      );
      const titleIds = new Set(terminalIds);
      const requested = [...new Set([...originals, ...terminalIds])];
      const homes = new Map<number, string[]>();
      for (const id of requested) {
        const route = routeOf(id);
        if (route === null) return null;
        const home = partitionOf(route);
        const group = homes.get(home) ?? [];
        group.push(id);
        homes.set(home, group);
      }
      const clients = await partitionReadClients(client, [...homes.keys()]);
      const sourceRows: SourceRow[] = [];
      for (const [partition, ids] of homes) {
        requireAccessDeadline(deadline);
        const found = (await readTitleInputs.run(clients.get(partition)!, {
          partition_no: partition,
          context_id: GLOBAL_SUBJECT_CONTEXT,
          subjects: ids.map((id) => ({
            route: routeOf(id)!,
            id,
            original: titleIds.has(id) ? slotId(id, 'schema:inLanguage') : null,
          })),
        })) as SourceRow[];
        if (found.length !== ids.length || new Set(found.map((row) => row.id)).size !== ids.length) return null;
        sourceRows.push(...found);
      }
      return bindSemanticTitleInputRows(originals, mappings, sourceRows);
    },
    deadline,
  );
}

/** Bind one current pool; each basis and exact batch snapshot is released before this callable resolves. */
export function createNativeSemanticTitleInputs(pool: Pool): SemanticTitleInputs {
  return createSemanticTitleInputsObserver({
    readBasis: async (deadline) => {
      try {
        return await readNativeTitleBasis(pool, deadline);
      } catch (error) {
        if (error instanceof CommandUnavailableError) return null;
        throw error;
      }
    },
    readBatch: async (subjects, deadline) => {
      try {
        return await readNativeTitleBatch(pool, subjects, deadline);
      } catch (error) {
        if (error instanceof CommandUnavailableError) return null;
        throw error;
      }
    },
    requireDeadline: requireAccessDeadline,
  });
}
