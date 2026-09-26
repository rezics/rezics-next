import { createHash } from 'node:crypto';
import type { SourceRunStore } from './acquisition-run.ts';
import { projectVndbConceptCaptures, VndbConceptInvalid, type VndbConceptProjection } from './field-vndb.ts';

/** A bounded QA conformance profile over a frozen four-surface Kana-shaped capture set. */
export const VNDB_CONCEPT_FIXTURE_PROFILE = 'vndb-concept-fixture-v1';
export const VNDB_CONCEPT_FIXTURE_PROVIDER = 'vndb-fixture';
export const VNDB_CONCEPT_SURFACES = ['vn', 'character', 'tag', 'trait'] as const;
export const VNDB_CONCEPT_FIXTURE_RUN = VNDB_CONCEPT_FIXTURE_PROFILE;
const SURFACES = VNDB_CONCEPT_SURFACES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iri = (id: string) => `https://rezics.com/id/${id}`;

export class VndbConceptRunInvalid extends Error {}
export class VndbConceptRunUnavailable extends Error {}

export interface VndbConceptRunCapture {
  surface: typeof SURFACES[number];
  observation: string;
  requestKey: string;
  url: string;
  fetchedAt: string;
  digest: string;
  bytes: Buffer;
}

export interface VndbConceptRunSnapshot {
  profile: typeof VNDB_CONCEPT_FIXTURE_RUN;
  run: string;
  provider: typeof VNDB_CONCEPT_FIXTURE_PROVIDER;
  position: { dataEpoch: string; sequence: string };
  projection: VndbConceptProjection;
  captures: VndbConceptRunCapture[];
  work: { captures: number; bytes: number; concepts: number; claims: number; fields: number };
}

/**
 * Re-read and project only the immutable captures belonging to this principal's
 * completed VNDB fixture run. The shared SourceRunStore supplies the indexed
 * run/capture reads; this adapter makes no provider call and accepts four 64 KiB
 * captures, at most 100 root items and 100 associations per root.
 */
export async function readVndbConceptRun(runs: Pick<SourceRunStore, 'read' | 'frozen'>,
  principalId: string, runId: string): Promise<VndbConceptRunSnapshot> {
  if (!UUID.test(principalId) || !UUID.test(runId)) throw new VndbConceptRunInvalid('invalid source run identity');
  const run = await runs.read(principalId, runId);
  if (!run) throw new VndbConceptRunUnavailable('source run is unavailable');
  if (run.provider !== VNDB_CONCEPT_FIXTURE_PROVIDER || run.acquisitionProfile !== VNDB_CONCEPT_FIXTURE_RUN) {
    throw new VndbConceptRunInvalid('source run is not the elected VNDB concept fixture profile');
  }
  if (run.state !== 'completed') throw new VndbConceptRunUnavailable('source run is not complete');
  if (run.surfaces.length !== SURFACES.length) throw new VndbConceptRunUnavailable('source run surfaces differ');

  const captures: VndbConceptRunCapture[] = [];
  for (const surface of SURFACES) {
    const view = run.surfaces.find(item => item.surface === surface);
    const listed = view?.captures[0];
    if (!view || !view.required || view.outcome?.outcome !== 'qualified' || view.captures.length !== 1 || !listed
      || listed.byteDigest === null || listed.retention !== 'retained' || listed.byteLength === null) {
      throw new VndbConceptRunUnavailable(`source run ${surface} capture is unavailable`);
    }
    const frozen = await runs.frozen(runId, listed.requestKey);
    if (!frozen || frozen.status !== 200 || !frozen.bytes || frozen.bytes.length !== listed.byteLength
      || sha(frozen.bytes) !== listed.byteDigest) {
      throw new VndbConceptRunUnavailable(`source run ${surface} capture digest differs`);
    }
    captures.push({ surface, observation: listed.observation, requestKey: listed.requestKey,
      url: listed.url, fetchedAt: listed.fetchedAt, digest: listed.byteDigest, bytes: frozen.bytes });
  }

  let projection: VndbConceptProjection;
  try {
    projection = projectVndbConceptCaptures(captures.map(capture => ({
      kind: capture.surface, bytes: capture.bytes, digest: capture.digest, complete: true,
    })));
  } catch (error) {
    if (error instanceof VndbConceptInvalid) throw new VndbConceptRunInvalid(error.message);
    throw error;
  }
  const positionDigest = sha(captures.map(capture => `${capture.surface}\t${capture.digest}`).join('\n'));
  return { profile: VNDB_CONCEPT_FIXTURE_RUN, run: iri(runId), provider: VNDB_CONCEPT_FIXTURE_PROVIDER,
    position: { dataEpoch: positionDigest, sequence: '0' }, projection, captures,
    work: { captures: captures.length, bytes: captures.reduce((sum, capture) => sum + capture.bytes.length, 0),
      concepts: projection.concepts.length, claims: projection.claims.length, fields: projection.fieldInventory.length } };
}

export interface VndbFieldDrift {
  grain: typeof SURFACES[number];
  field: string;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  baseItems: number;
  candidateItems: number;
  changedItems: number;
  disposition: VndbConceptProjection['fieldInventory'][number]['disposition'];
  reason: string;
}

type Observed = Map<string, Map<string, string>>;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function observe(capture: VndbConceptRunCapture): Observed {
  let parsed: unknown;
  try { parsed = JSON.parse(capture.bytes.toString('utf8')); }
  catch { throw new VndbConceptRunUnavailable('frozen source capture is malformed'); }
  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results) || results.length > 100) throw new VndbConceptRunUnavailable('frozen source capture is unbounded');
  const fields: Observed = new Map();
  for (const item of results) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new VndbConceptRunUnavailable('frozen source item is malformed');
    }
    const root = item as Record<string, unknown>;
    if (typeof root.id !== 'string') throw new VndbConceptRunUnavailable('frozen source item identity is missing');
    const values = new Map<string, string>();
    const walk = (value: unknown, prefix = '', depth = 0): void => {
      if (depth > 4) throw new VndbConceptRunUnavailable('frozen source field nesting exceeds the profile');
      if (Array.isArray(value)) {
        if (prefix) values.set(prefix, stable(value));
        for (const child of value) walk(child, prefix, depth + 1);
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        values.set(path, stable(child));
        walk(child, path, depth + 1);
      }
    };
    walk(root);
    for (const [field, value] of values) {
      const items = fields.get(field) ?? new Map<string, string>();
      items.set(root.id, value);
      fields.set(field, items);
    }
  }
  return fields;
}

/** Compare only matching frozen runs; omissions describe source drift and never withdraw native facts. */
export function compareVndbConceptRuns(base: VndbConceptRunSnapshot,
  candidate: VndbConceptRunSnapshot): VndbFieldDrift[] {
  if (base.provider !== candidate.provider || base.run === candidate.run) {
    throw new VndbConceptRunInvalid('source run comparison requires distinct VNDB fixture runs');
  }
  const fields: VndbFieldDrift[] = [];
  const baseInventory = new Map(base.projection.fieldInventory.map(item => [`${item.grain}/${item.field}`, item]));
  const candidateInventory = new Map(candidate.projection.fieldInventory.map(item => [`${item.grain}/${item.field}`, item]));
  for (const grain of SURFACES) {
    const left = observe(base.captures.find(capture => capture.surface === grain)!);
    const right = observe(candidate.captures.find(capture => capture.surface === grain)!);
    const names = new Set([...left.keys(), ...right.keys()]);
    for (const field of [...names].sort()) {
      const before = left.get(field) ?? new Map<string, string>();
      const after = right.get(field) ?? new Map<string, string>();
      const paired = [...before.keys()].filter(id => after.has(id));
      const changedItems = paired.filter(id => before.get(id) !== after.get(id)).length;
      const declaration = candidateInventory.get(`${grain}/${field}`) ?? baseInventory.get(`${grain}/${field}`);
      fields.push({ grain, field,
        status: before.size === 0 ? 'added' : after.size === 0 ? 'removed' : changedItems ? 'changed' : 'unchanged',
        baseItems: before.size, candidateItems: after.size, changedItems,
        disposition: declaration?.disposition ?? 'unsupported', reason: declaration?.reason ?? 'undeclared-field' });
    }
  }
  return fields;
}
