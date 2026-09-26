import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { OPEN_LIBRARY_WORKS_RUN, SourceRunInvalid, SourceRunUnavailable } from './acquisition-run.ts';
import type { FieldDisposition } from './field-schema.ts';
import type { SurfaceOutcome } from './run-schema.ts';

export const OPEN_LIBRARY_RUN_MAP = 'open-library-run-map-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRAINS: Record<string, string> = { works: 'work', editions: 'edition', ratings: 'ratings',
  bookshelves: 'work-bookshelves' };
const MAX_FIELDS = 256;

export interface RunFieldDrift {
  field: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  baseItems: number;
  candidateItems: number;
  changedItems: number;
  disposition: FieldDisposition;
  reason: string;
}

export interface RunSurfaceDrift {
  surface: string;
  grain: string;
  status: 'compared' | 'unavailable';
  base: { outcome: SurfaceOutcome; reason: string } | null;
  candidate: { outcome: SurfaceOutcome; reason: string } | null;
  itemsPaired: number;
  itemsAdded: number;
  itemsRemoved: number;
  fields: RunFieldDrift[];
}

export interface SourceRunDrift {
  profile: 'source-run-drift-v1';
  baseRun: string;
  candidateRun: string;
  acquisitionProfile: string;
  mappingRevision: typeof OPEN_LIBRARY_RUN_MAP;
  surfaces: RunSurfaceDrift[];
}

function stable(value: unknown, depth = 0): string {
  if (depth > 64) throw new SourceRunInvalid('source drift exceeds the nesting limit');
  if (Array.isArray(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item, depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

type Items = Map<string, Record<string, unknown>>;

/** Items of one surface grain, keyed by provider identity, from frozen run captures only. */
function surfaceItems(surface: string, captures: Array<{ externalId: string; bytes: Buffer }>): Items {
  const items: Items = new Map();
  for (const capture of captures) {
    let parsed: unknown;
    try { parsed = JSON.parse(capture.bytes.toString('utf8')); }
    catch { throw new SourceRunUnavailable('frozen run capture is not JSON'); }
    const entries = surface === 'editions'
      ? (parsed as { entries?: unknown[] }).entries ?? [] : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new SourceRunUnavailable('frozen run capture has an unexpected shape');
      }
      const record = entry as Record<string, unknown>;
      const identity = surface === 'ratings' || surface === 'bookshelves'
        ? capture.externalId : String(record.key);
      // Offset paging can repeat an entry across pages; the later page is the same identity.
      items.set(identity, record);
    }
  }
  return items;
}

export function compareSurfaceItems(base: Items, candidate: Items,
  catalog: ReadonlyMap<string, { disposition: FieldDisposition; reason: string }>):
  Pick<RunSurfaceDrift, 'itemsPaired' | 'itemsAdded' | 'itemsRemoved' | 'fields'> {
  const fields = new Set<string>();
  for (const items of [base, candidate]) for (const item of items.values()) for (const key of Object.keys(item)) fields.add(key);
  if (fields.size > MAX_FIELDS) throw new SourceRunInvalid('source drift exceeds the field inventory limit');
  const paired = [...base.keys()].filter(identity => candidate.has(identity));
  const count = (items: Items, field: string) => [...items.values()].filter(item => Object.hasOwn(item, field)).length;
  return {
    itemsPaired: paired.length,
    itemsAdded: [...candidate.keys()].filter(identity => !base.has(identity)).length,
    itemsRemoved: [...base.keys()].filter(identity => !candidate.has(identity)).length,
    fields: [...fields].sort().map(field => {
      const baseItems = count(base, field);
      const candidateItems = count(candidate, field);
      const changedItems = paired.filter(identity => {
        const left = base.get(identity)!;
        const right = candidate.get(identity)!;
        return Object.hasOwn(left, field) !== Object.hasOwn(right, field)
          || (Object.hasOwn(left, field) && stable(left[field]) !== stable(right[field]));
      }).length;
      const declared = catalog.get(field);
      return { field,
        status: baseItems === 0 ? 'added' : candidateItems === 0 ? 'removed' : changedItems ? 'changed' : 'unchanged',
        baseItems, candidateItems, changedItems,
        disposition: declared?.disposition ?? 'unsupported', reason: declared?.reason ?? 'undeclared-field' };
    }),
  };
}

interface CaptureRow { surface: string; external_id: string; raw_bytes: Buffer | null; byte_digest: string | null }
interface SurfaceRow { surface: string; outcome: SurfaceOutcome | null; reason: string | null }

/**
 * Compare two terminal runs of one principal and profile from their frozen captures. A
 * removed field or item is reported, never acted on; an unqualified surface is unavailable.
 */
export class SourceRunDriftReader {
  constructor(private readonly pool: Pool) {}

  async compare(principalId: string, baseRunId: string, candidateRunId: string): Promise<SourceRunDrift | null> {
    if (![principalId, baseRunId, candidateRunId].every(id => UUID.test(id)) || baseRunId === candidateRunId) {
      throw new SourceRunInvalid('invalid source run comparison');
    }
    const runs = await this.pool.query<{ id: string; profile: string; completed: boolean }>(
      `SELECT r.id, r.profile, c.run_id IS NOT NULL AS completed FROM source.acquisition_run r
       LEFT JOIN source.acquisition_run_completion c ON c.run_id = r.id
       WHERE r.id = ANY($1::uuid[]) AND r.principal_id = $2`, [[baseRunId, candidateRunId], principalId]);
    if (runs.rowCount !== 2) return null;
    if (runs.rows.some(run => run.profile !== OPEN_LIBRARY_WORKS_RUN)) {
      throw new SourceRunInvalid('source runs use different acquisition profiles');
    }
    if (runs.rows.some(run => !run.completed)) throw new SourceRunInvalid('source run is still executing');
    const catalog = await this.pool.query<{ grain: string; field_key: string; disposition: FieldDisposition;
      reason: string }>(`SELECT grain, field_key, disposition, reason FROM source.field_disposition
      WHERE mapping_revision = $1`, [OPEN_LIBRARY_RUN_MAP]);
    if (!catalog.rowCount) throw new SourceRunUnavailable('source field mapping is unavailable');
    const load = async (runId: string) => {
      const surfaces = await this.pool.query<SurfaceRow>(`SELECT s.surface, o.outcome, o.reason
        FROM source.acquisition_run_surface s
        LEFT JOIN source.run_surface_outcome o ON o.run_id = s.run_id AND o.surface = s.surface
        WHERE s.run_id = $1`, [runId]);
      const captures = await this.pool.query<CaptureRow>(`SELECT c.surface, r.external_id, o.raw_bytes, o.byte_digest
        FROM source.run_capture c JOIN source.observation o ON o.id = c.observation_id
        JOIN source.record r ON r.id = o.record_id WHERE c.run_id = $1 ORDER BY c.surface, c.ordinal`, [runId]);
      for (const capture of captures.rows) {
        if (!capture.raw_bytes || createHash('sha256').update(capture.raw_bytes).digest('hex') !== capture.byte_digest) {
          throw new SourceRunUnavailable('frozen run capture digest differs');
        }
      }
      return { surfaces: new Map(surfaces.rows.map(row => [row.surface, row])), captures: captures.rows };
    };
    const [base, candidate] = [await load(baseRunId), await load(candidateRunId)];
    const surfaces: RunSurfaceDrift[] = Object.entries(GRAINS).map(([surface, grain]) => {
      const left = base.surfaces.get(surface);
      const right = candidate.surfaces.get(surface);
      const side = (row?: SurfaceRow) => row?.outcome ? { outcome: row.outcome, reason: row.reason! } : null;
      const summary = { surface, grain, base: side(left), candidate: side(right) };
      if (left?.outcome !== 'qualified' || right?.outcome !== 'qualified') {
        return { ...summary, status: 'unavailable', itemsPaired: 0, itemsAdded: 0, itemsRemoved: 0, fields: [] };
      }
      const items = (captures: CaptureRow[]) => surfaceItems(surface, captures.filter(row => row.surface === surface)
        .map(row => ({ externalId: row.external_id, bytes: row.raw_bytes! })));
      const declared = new Map(catalog.rows.filter(row => row.grain === grain)
        .map(row => [row.field_key, { disposition: row.disposition, reason: row.reason }]));
      return { ...summary, status: 'compared',
        ...compareSurfaceItems(items(base.captures), items(candidate.captures), declared) };
    });
    return { profile: 'source-run-drift-v1', baseRun: `https://rezics.com/id/${baseRunId}`,
      candidateRun: `https://rezics.com/id/${candidateRunId}`, acquisitionProfile: OPEN_LIBRARY_WORKS_RUN,
      mappingRevision: OPEN_LIBRARY_RUN_MAP, surfaces };
  }
}
