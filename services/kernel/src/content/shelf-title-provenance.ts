import type { Pool } from 'pg';
import { deadlineClient } from '../access/deadline.ts';
import { withBoundedReadOnlyTransaction } from '../database/pool.ts';
import { readPartitions } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readFences, type SourceFence, type SourceFenceTuple } from './source-fences.ts';
import { SEMANTIC_TITLE_PROVENANCE_MAX_BYTES } from '../semantic/contract/index.ts';
import {
  createSemanticTitleProvenanceAdapter,
  type SemanticTitleFieldBinding,
  type SemanticTitleProvenance,
  type SemanticTitleProvenanceEntry,
} from '../semantic/adapters/title-inputs-provenance.ts';
import type { ContentShelfTitleNativeObserver } from '../library/shelf-title-inputs-composition.ts';

const unavailable = { status: 'unavailable' as const };
const FENCE_BATCH_SIZE = 100;
// An imported origin is much larger than 16 encoded bytes in Semantic's bounded result.
// This conservative derived ceiling makes the number of fence batches finite as well.
const MAX_FENCE_TUPLES = Math.ceil(SEMANTIC_TITLE_PROVENANCE_MAX_BYTES / 16);
const languageTag = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$(?![\s\S])/i;

type FenceReader = (tuples: readonly SourceFenceTuple[], deadline: number) => Promise<readonly SourceFence[]>;

function tupleKey(tuple: SourceFenceTuple): string {
  return JSON.stringify([tuple.route, tuple.source, tuple.external_id, tuple.field_group]);
}

/** A non-imported title field has no Content source-fence tuple. */
function importedTuple(binding: SemanticTitleFieldBinding): SourceFenceTuple | null | undefined {
  if (!binding || typeof binding.value !== 'string' || !binding.origin || typeof binding.origin !== 'object')
    return undefined;
  if (binding.origin.kind === 'native') return null;
  if (binding.origin.kind === 'agent')
    return typeof binding.origin.subject === 'string' && routeOf(binding.origin.subject) !== null ? null : undefined;
  if (
    binding.origin.kind !== 'imported' ||
    !Number.isInteger(binding.origin.route) ||
    binding.origin.route < 0 ||
    binding.origin.route > 0xffff ||
    typeof binding.origin.source !== 'string' ||
    typeof binding.origin.external_id !== 'string' ||
    !['facts', 'summary', 'cover'].includes(binding.origin.field_group)
  )
    return undefined;
  return {
    route: binding.origin.route,
    source: binding.origin.source,
    external_id: binding.origin.external_id,
    field_group: binding.origin.field_group,
  };
}

function exactEntries(
  subjects: readonly string[],
  entries: readonly SemanticTitleProvenanceEntry[],
): SemanticTitleProvenanceEntry[] | undefined {
  if (!Array.isArray(entries) || entries.length !== subjects.length) return undefined;
  const expected = new Set(subjects);
  const bySubject = new Map<string, SemanticTitleProvenanceEntry>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.subjectId !== 'string' ||
      !expected.delete(entry.subjectId) ||
      !entry.source ||
      typeof entry.source.subjectId !== 'string' ||
      routeOf(entry.source.subjectId) === null ||
      typeof entry.source.identityEpoch !== 'string' ||
      !entry.source.identityEpoch ||
      !Number.isSafeInteger(entry.source.terminalRevision) ||
      entry.source.terminalRevision < 1 ||
      typeof entry.sourceBasis !== 'string' ||
      !entry.sourceBasis ||
      entry.sourceBasis.length > 256 ||
      !entry.labels ||
      typeof entry.labels !== 'object' ||
      Array.isArray(entry.labels) ||
      (entry.originalLanguage !== null &&
        entry.originalLanguage !== undefined &&
        typeof entry.originalLanguage !== 'object')
    )
      return undefined;
    if (routeOf(entry.subjectId) === null) return undefined;
    for (const [language, binding] of Object.entries(entry.labels)) {
      if (
        !languageTag.test(language) ||
        !binding ||
        typeof binding !== 'object' ||
        !('value' in binding) ||
        typeof binding.value !== 'string'
      )
        return undefined;
    }
    if (entry.originalLanguage !== null && entry.originalLanguage !== undefined) {
      if (typeof entry.originalLanguage.value !== 'string') return undefined;
    }
    bySubject.set(entry.subjectId, entry);
  }
  return expected.size === 0 ? subjects.map((subject) => bySubject.get(subject)!) : undefined;
}

function collectTuples(entries: readonly SemanticTitleProvenanceEntry[]): SourceFenceTuple[] | undefined {
  const tuples = new Map<string, SourceFenceTuple>();
  const add = (binding: SemanticTitleFieldBinding): boolean => {
    const tuple = importedTuple(binding);
    if (tuple === undefined) return false;
    if (tuple !== null) tuples.set(tupleKey(tuple), tuple);
    return tuples.size <= MAX_FENCE_TUPLES;
  };
  for (const entry of entries) {
    for (const binding of Object.values(entry.labels)) if (!add(binding)) return undefined;
    if (entry.originalLanguage && !add(entry.originalLanguage)) return undefined;
  }
  return [...tuples.values()];
}

function exactFenceRows(
  tuples: readonly SourceFenceTuple[],
  rows: readonly SourceFence[],
): Map<string, boolean> | undefined {
  if (!Array.isArray(rows) || rows.length !== tuples.length) return undefined;
  const expected = new Set(tuples.map(tupleKey));
  const byTuple = new Map<string, boolean>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.takenDown !== 'boolean') return undefined;
    const key = tupleKey(row);
    if (!expected.delete(key)) return undefined;
    byTuple.set(key, row.takenDown);
  }
  return expected.size === 0 ? byTuple : undefined;
}

/**
 * Bind Semantic's exact field provenance to current Content fences. Fence reads use independent
 * bounded snapshots, each anchored to every referenced native partition before reading its <=100 tuples.
 */
export function createContentShelfTitleProvenanceObserver(
  provenance: SemanticTitleProvenance,
  readFenceBatch: FenceReader,
): ContentShelfTitleNativeObserver {
  return {
    async observe(input) {
      if (
        !Number.isFinite(input.deadline) ||
        !Array.isArray(input.subjects) ||
        input.subjects.length > 100 ||
        new Set(input.subjects).size !== input.subjects.length ||
        input.subjects.some((subject) => routeOf(subject) === null)
      )
        return unavailable;
      try {
        const observed = await provenance.observe({ subjects: [...input.subjects], deadline: input.deadline });
        if (
          observed.status !== 'current' ||
          typeof observed.basis !== 'string' ||
          !observed.basis ||
          observed.basis.length > 256
        )
          return unavailable;
        const entries = exactEntries(input.subjects, observed.entries);
        if (!entries) return unavailable;
        const tuples = collectTuples(entries);
        if (!tuples) return unavailable;

        const fences = new Map<string, boolean>();
        for (let offset = 0; offset < tuples.length; offset += FENCE_BATCH_SIZE) {
          const batch = tuples.slice(offset, offset + FENCE_BATCH_SIZE);
          const rows = await readFenceBatch(batch, input.deadline);
          const current = exactFenceRows(batch, rows);
          if (!current) return unavailable;
          for (const [key, takenDown] of current) fences.set(key, takenDown);
        }

        const output = entries.map((entry) => {
          const labels: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [language, binding] of Object.entries(entry.labels)) {
            const tuple = importedTuple(binding);
            if (tuple === undefined) throw new TypeError('Invalid title field provenance');
            if (tuple === null || fences.get(tupleKey(tuple)) === false) labels[language] = binding.value;
            else if (tuple !== null && !fences.has(tupleKey(tuple)))
              throw new TypeError('Missing title source-fence observation');
          }
          let originalLanguage: string | null = null;
          if (entry.originalLanguage) {
            const tuple = importedTuple(entry.originalLanguage);
            if (tuple === undefined) throw new TypeError('Invalid original-language provenance');
            if (tuple === null || fences.get(tupleKey(tuple)) === false)
              originalLanguage = entry.originalLanguage.value;
            else if (!fences.has(tupleKey(tuple)))
              throw new TypeError('Missing original-language source-fence observation');
          }
          return {
            subjectId: entry.subjectId,
            sourceId: entry.source.subjectId,
            sourceBasis: entry.sourceBasis,
            labels,
            originalLanguage,
          };
        });
        return { status: 'current' as const, version: observed.basis, entries: output };
      } catch {
        return unavailable;
      }
    },
  };
}

async function readNativeFenceBatch(
  pool: Pool,
  tuples: readonly SourceFenceTuple[],
  deadline: number,
): Promise<readonly SourceFence[]> {
  if (!tuples.length || tuples.length > FENCE_BATCH_SIZE) throw new RangeError('Invalid title source-fence batch');
  return withBoundedReadOnlyTransaction(pool, deadline, async (client) => {
    const bounded = deadlineClient(client, deadline);
    const partitions = [...new Set(tuples.map((tuple) => partitionOf(tuple.route)))].sort((a, b) => a - b);
    const anchors = await readPartitions(bounded, partitions);
    const expected = new Set(partitions);
    if (
      anchors.length !== partitions.length ||
      anchors.some((partition) => !expected.delete(partition.partitionNo) || partition.writeState === 'moved') ||
      expected.size !== 0
    )
      throw new Error('Title source-fence partition is unavailable');
    return readFences(bounded, tuples);
  });
}

/** Constructing the native observer is inert; provenance and Access I/O start only on an actual request. */
export function createNativeContentShelfTitleProvenanceObserver(
  pool: Pool,
  routeKey: Uint8Array,
): ContentShelfTitleNativeObserver {
  const provenance = createSemanticTitleProvenanceAdapter(pool, routeKey);
  return createContentShelfTitleProvenanceObserver(provenance, (tuples, deadline) =>
    readNativeFenceBatch(pool, tuples, deadline),
  );
}
