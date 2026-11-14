import type { Pool } from 'pg';
import { CommandUnavailableError, requireAccessDeadline } from '../access/unavailable.ts';
import { partitionReadClients } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type {
  SemanticTitleFieldBinding,
  SemanticTitleInputEntry,
  SemanticTitleProvenance,
  SemanticTitleProvenanceEntry,
  SemanticTitleProvenanceOrigin,
  SemanticTitleProvenanceSupport,
} from './contract/index.ts';
import { SEMANTIC_TITLE_PROVENANCE_MAX_BYTES } from './contract/title-inputs-provenance.ts';
import { GLOBAL_SUBJECT_CONTEXT } from './contract/subject-values.ts';
import { importedTupleRouteOf } from './adapters/imported-route.ts';
import { slotId } from './slots.ts';
import { withReadTransaction } from './read.ts';
import { createNativeSemanticTitleInputs } from './title-inputs.ts';
import readTitleInputProvenance from './title-inputs-provenance-read.sql';

type ObjectValue = Record<string, unknown>;
type RawFieldBinding = Readonly<{
  value?: unknown;
  revision?: unknown;
  slot?: unknown;
  sequence?: unknown;
  source?: unknown;
}>;
type ImportedSource = Readonly<{
  source: string;
  external_id: string;
  record_revision: string;
  digest: string;
  converter_revision: string;
  field_group: 'facts' | 'summary' | 'cover';
}>;
type SourceRow = Readonly<{
  id: string;
  labelBindings: unknown;
  labelBindingsComplete: boolean;
  original: string | null;
  originalCandidate: string | null;
  originalSupportRevision: string | null;
  originalSource: unknown;
  redirect: string | null;
  revision: string | null;
}>;
type ImportedRoute = (source: string, externalId: string) => number;

const unavailable = { status: 'unavailable' as const };
const object = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function importedSource(value: unknown): ImportedSource | null {
  if (!object(value)) return null;
  const { source, external_id, record_revision, digest, converter_revision, field_group } = value;
  if (
    typeof source !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,31}$/.test(source) ||
    typeof external_id !== 'string' ||
    external_id.length < 1 ||
    external_id.length > 255 ||
    !external_id.isWellFormed() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(external_id) ||
    typeof record_revision !== 'string' ||
    record_revision.length < 1 ||
    record_revision.length > 64 ||
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    typeof converter_revision !== 'string' ||
    converter_revision.length < 1 ||
    converter_revision.length > 64 ||
    !['facts', 'summary', 'cover'].includes(String(field_group))
  )
    return null;
  return {
    source,
    external_id,
    record_revision,
    digest,
    converter_revision,
    field_group: field_group as ImportedSource['field_group'],
  };
}

function originOf(value: unknown, importedRoute: ImportedRoute): SemanticTitleProvenanceOrigin | null {
  if (value === null) return { kind: 'native' };
  if (!object(value)) return null;
  if (value.kind === 'agent') {
    if (Object.keys(value).length !== 2 || typeof value.subject !== 'string' || routeOf(value.subject) === null)
      return null;
    return { kind: 'agent', subject: value.subject };
  }
  const source = importedSource(value);
  if (!source) return null;
  let route: number;
  try {
    route = importedRoute(source.source, source.external_id);
  } catch {
    return null;
  }
  if (!Number.isInteger(route) || route < 0 || route > 65535) return null;
  return {
    kind: 'imported',
    route,
    source: source.source,
    external_id: source.external_id,
    field_group: source.field_group,
  };
}

function sameMap(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function labelBinding(value: unknown, importedRoute: ImportedRoute): SemanticTitleFieldBinding | null {
  if (!object(value) || !Object.hasOwn(value, 'source')) return null;
  const raw = value as RawFieldBinding;
  const revision = positiveInteger(raw.revision);
  const sequence = positiveInteger(raw.sequence);
  const origin = originOf(raw.source, importedRoute);
  if (
    typeof raw.value !== 'string' ||
    typeof raw.slot !== 'string' ||
    routeOf(raw.slot) === null ||
    revision === null ||
    sequence === null ||
    !origin
  )
    return null;
  const support: SemanticTitleProvenanceSupport = {
    kind: 'term',
    revision,
    slot: raw.slot,
    sequence,
  };
  return { value: raw.value, origin, support };
}

function statementBinding(
  value: string,
  candidateValue: unknown,
  revisionValue: unknown,
  sourceValue: unknown,
  sourceId: string,
  importedRoute: ImportedRoute,
): SemanticTitleFieldBinding | null {
  const revision = positiveInteger(revisionValue);
  const origin = originOf(sourceValue, importedRoute);
  if (
    typeof candidateValue !== 'string' ||
    routeOf(candidateValue) !== routeOf(sourceId) ||
    revision === null ||
    !origin
  )
    return null;
  const support: SemanticTitleProvenanceSupport = { kind: 'statement', revision, candidate: candidateValue };
  return { value, origin, support };
}

/** Bind current title values to their exact term and Global statement support. */
export function bindSemanticTitleProvenanceRows(
  entries: readonly SemanticTitleInputEntry[],
  rows: readonly SourceRow[],
  importedRoute: ImportedRoute,
): readonly SemanticTitleProvenanceEntry[] | null {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const expectedSources = new Set(entries.map((entry) => entry.sourceId));
  if (
    byId.size !== rows.length ||
    byId.size !== expectedSources.size ||
    [...expectedSources].some((id) => !byId.has(id))
  )
    return null;
  const result: SemanticTitleProvenanceEntry[] = [];
  for (const entry of entries) {
    const row = byId.get(entry.sourceId);
    const labels = object(row?.labelBindings) ? row.labelBindings : null;
    const sourceMatch = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(entry.sourceBasis);
    const identityEpoch = sourceMatch?.[1];
    const terminalRevision = sourceMatch ? positiveInteger(sourceMatch[2]) : null;
    if (
      !row ||
      !labels ||
      row.labelBindingsComplete !== true ||
      row.original !== entry.originalLanguage ||
      row.redirect !== null ||
      positiveInteger(row.revision) !== terminalRevision ||
      !identityEpoch ||
      terminalRevision === null
    )
      return null;
    const labelKeys = Object.keys(entry.labels).sort();
    const bindingKeys = Object.keys(labels).sort();
    if (
      labelKeys.length !== bindingKeys.length ||
      labelKeys.some((key, index) => key !== bindingKeys[index])
    )
      return null;
    const boundLabels: Record<string, SemanticTitleFieldBinding> = {};
    for (const language of labelKeys) {
      const binding = labelBinding(labels[language], importedRoute);
      if (!binding || binding.value !== entry.labels[language]) return null;
      boundLabels[language] = binding;
    }

    let originalLanguage: SemanticTitleFieldBinding | null = null;
    if (entry.originalLanguage === null) {
      if (
        row.originalCandidate !== null ||
        row.originalSupportRevision !== null ||
        row.originalSource !== null
      )
        return null;
    } else {
      originalLanguage = statementBinding(
        entry.originalLanguage,
        row.originalCandidate,
        row.originalSupportRevision,
        row.originalSource,
        entry.sourceId,
        importedRoute,
      );
      if (!originalLanguage) return null;
    }
    result.push({
      subjectId: entry.subjectId,
      source: { subjectId: entry.sourceId, identityEpoch, terminalRevision },
      sourceBasis: entry.sourceBasis,
      labels: boundLabels,
      originalLanguage,
    });
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SEMANTIC_TITLE_PROVENANCE_MAX_BYTES) return null;
  return result;
}

function sourceRowsByHome(entries: readonly SemanticTitleInputEntry[]) {
  const homes = new Map<number, { route: number; id: string; languageSlot: string; labels: unknown; original: string | null }[]>();
  const byId = new Map<string, SemanticTitleInputEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.sourceId);
    if (
      existing &&
      (!sameMap(existing.labels, entry.labels) || existing.originalLanguage !== entry.originalLanguage)
    )
      return null;
    byId.set(entry.sourceId, entry);
  }
  for (const entry of byId.values()) {
    const route = routeOf(entry.sourceId);
    if (route === null) return null;
    const home = partitionOf(route);
    const group = homes.get(home) ?? [];
    group.push({
      route,
      id: entry.sourceId,
      languageSlot: slotId(entry.sourceId, 'schema:inLanguage'),
      labels: entry.labels,
      original: entry.originalLanguage,
    });
    homes.set(home, group);
  }
  return homes;
}

async function readProvenanceSnapshot(
  pool: Pool,
  entries: readonly SemanticTitleInputEntry[],
  deadline: number,
): Promise<readonly SourceRow[] | null> {
  const homes = sourceRowsByHome(entries);
  if (!homes) return null;
  return withReadTransaction(
    pool,
    async (client) => {
      requireAccessDeadline(deadline);
      const clients = await partitionReadClients(client, [...homes.keys()]);
      const rows: SourceRow[] = [];
      for (const [partition, requested] of homes) {
        requireAccessDeadline(deadline);
        const found = (await readTitleInputProvenance.run(clients.get(partition)!, {
          partition_no: partition,
          context_id: GLOBAL_SUBJECT_CONTEXT,
          subjects: requested,
        })) as SourceRow[];
        if (found.length !== requested.length || new Set(found.map((row) => row.id)).size !== requested.length)
          return null;
        rows.push(...found);
      }
      requireAccessDeadline(deadline);
      return rows;
    },
    deadline,
  );
}

/** Reuse the current title observer; bracket the keyed provenance read with its whole-source basis. */
export function createNativeSemanticTitleProvenance(pool: Pool, routeKey: Uint8Array): SemanticTitleProvenance {
  const titleInputs = createNativeSemanticTitleInputs(pool);
  const stableRouteKey = new Uint8Array(routeKey);
  const tupleRoute = importedTupleRouteOf(pool);
  const importedRoute: ImportedRoute = (source, externalId) => tupleRoute(stableRouteKey, source, externalId);
  return {
    async observe({ subjects, deadline }) {
      const before = await titleInputs.observe({ subjects, deadline });
      if (before.status !== 'current') return unavailable;
      if (subjects.length === 0) return { status: 'current', basis: before.basis, entries: [] };
      if (before.entries.length !== subjects.length) return unavailable;
      let rows: readonly SourceRow[] | null;
      try {
        rows = await readProvenanceSnapshot(pool, before.entries, deadline);
      } catch (error) {
        if (error instanceof CommandUnavailableError) return unavailable;
        throw error;
      }
      if (!rows) return unavailable;
      const after = await titleInputs.observe({ subjects: [], deadline });
      if (after.status !== 'current' || after.basis !== before.basis) return unavailable;
      const entries = bindSemanticTitleProvenanceRows(before.entries, rows, importedRoute);
      try {
        requireAccessDeadline(deadline);
      } catch (error) {
        if (error instanceof CommandUnavailableError) return unavailable;
        throw error;
      }
      if (
        !entries ||
        Buffer.byteLength(JSON.stringify({ status: 'current', basis: before.basis, entries }), 'utf8') >
          SEMANTIC_TITLE_PROVENANCE_MAX_BYTES
      )
        return unavailable;
      return { status: 'current', basis: before.basis, entries };
    },
  };
}
