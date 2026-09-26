import { createHash } from 'node:crypto';
import type { CaptureRequest, SourceRunProviderAdapter, SourceRunStore, SourceRunView } from
  '../../../services/main/src/modules/source/acquisition-run.ts';
import { VNDB_CONCEPT_FIXTURE_PROFILE, VNDB_CONCEPT_FIXTURE_PROVIDER, VNDB_CONCEPT_SURFACES } from
  '../../../services/main/src/modules/source/vndb-concept-run.ts';

export type VndbSurface = typeof VNDB_CONCEPT_SURFACES[number];
export type VndbFixtureBodies = Map<VndbSurface, Buffer>;
export interface VndbFixtureRunOptions {
  unqualifiedSurface?: VndbSurface;
  afterCapture?: (surface: VndbSurface) => void;
}

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Four bounded Kana-shaped captures; numeric JSON lexemes intentionally test byte preservation. */
export function vndbConceptBodies(revision: 'base' | 'candidate' = 'base'): VndbFixtureBodies {
  const vn = { results: [{ id: 'v1',
    ...(revision === 'base' ? { legacy_note: 'removed later' } : { future_field: { nested: true } }),
    tags: [
      { id: 'g1', name: 'Lead', rating: revision === 'base' ? 2.5 : 2.7, spoiler: 1, lie: false },
      { id: 'g2', name: 'Lead', rating: 1.2, spoiler: 2, lie: true },
      { id: 'g99', name: 'Missing definition', rating: 1, spoiler: 0, lie: false },
    ] }], more: false };
  const character = { results: [{ id: 'c1', name: 'A', traits: [
    { id: 'i1', name: 'Lead', group_id: 'i9', group_name: 'Role', spoiler: 1, lie: false },
    { id: 'i404', name: 'Unresolved', group_id: 'i9', group_name: 'Role', spoiler: 0, lie: false },
  ], vns: [
    { id: 'v1', release: { id: 'r1' }, role: 'main', spoiler: 0 },
    { id: 'v1', release: { id: 'r2' }, role: 'side', spoiler: 2 },
  ] }], more: false };
  const tag = { results: [
    { id: 'g1', name: 'Lead', description: revision === 'base' ? 'Content meaning' : 'Changed content meaning',
      category: 'cont' },
    { id: 'g2', name: 'Lead', description: 'Technical meaning', category: 'tech' },
  ], more: false };
  const trait = { results: [{ id: 'i1', name: 'Lead', description: 'Character meaning',
    group_id: 'i9', group_name: 'Role' }, { id: 'i9', name: 'Role', description: null,
    group_id: 'i9', group_name: 'Role' }], more: false };
  const bodies: VndbFixtureBodies = new Map([
    ['vn', Buffer.from(JSON.stringify(vn).replace('"rating":2.5', '"rating":2.500'))],
    ['character', Buffer.from(JSON.stringify(character))],
    ['tag', Buffer.from(JSON.stringify(tag))],
    ['trait', Buffer.from(JSON.stringify(trait))],
  ]);
  return bodies;
}

/** Persist the controlled source fixture through the general immutable run/capture owner. */
export async function captureVndbFixtureRun(runs: SourceRunStore, principalId: string, key: string,
  bodies: VndbFixtureBodies, options: VndbFixtureRunOptions = {}): Promise<SourceRunView> {
  const requestDigest = sha(JSON.stringify({ profile: VNDB_CONCEPT_FIXTURE_PROFILE, surfaces: VNDB_CONCEPT_SURFACES }));
  const surfaces = VNDB_CONCEPT_SURFACES.map((surface, ordinal) => ({ surface, required: true,
    captureLimit: 1, ordinal }));
  const started = await runs.start(principalId, key, VNDB_CONCEPT_FIXTURE_PROVIDER,
    VNDB_CONCEPT_FIXTURE_PROFILE, requestDigest, surfaces, 'urn:rezics:qa-fixture:vndb-kana');
  if (!started.created && await runs.isComplete(started.runId)) return (await runs.read(principalId, started.runId))!;

  const adapter: SourceRunProviderAdapter = {
    provider: VNDB_CONCEPT_FIXTURE_PROVIDER,
    termsReference: 'urn:rezics:qa-fixture:vndb-kana',
    fetch: async request => {
      const surface = surfaceOf(request.requestKey);
      if (surface === options.unqualifiedSurface) {
        return { ok: false, outcome: 'unqualified', reason: 'authorization-denied', status: 403 };
      }
      const bytes = bodies.get(surface);
      if (!bytes) return { ok: false, outcome: 'failed', reason: 'missing-fixture', status: null };
      return { ok: true, url: `fixture://vndb/kana/${surface}`, status: 200,
        mediaType: 'application/json', bytes: Buffer.from(bytes), parsed: JSON.parse(bytes.toString('utf8')),
        etag: null, lastModified: null, fetchedAt: '2026-09-27T00:00:00.000Z' };
    },
    decode: bytes => JSON.parse(bytes.toString('utf8')),
  };

  await runs.exclusive(started.runId, async () => {
    const settled = await runs.settledSurfaces(started.runId);
    let unavailable = false;
    for (const surface of VNDB_CONCEPT_SURFACES) {
      if (settled.has(surface)) continue;
      if (unavailable) {
        await runs.settle(started.runId, surface, 'unqualified', 'dependency-unavailable');
        continue;
      }
      const request: CaptureRequest = { requestKey: `fixture:vndb:${surface}`,
        path: `POST /kana/${surface}`, namespace: surface, externalId: `fixture-${surface}`,
        coverageScope: `vndb-${surface}-fixture-v1`, captureProfile: 'vndb-concept-fixture-capture-v1',
        validate: parsed => {
          const body = parsed && typeof parsed === 'object' ? parsed as { results?: unknown; more?: unknown } : null;
          return body && Array.isArray(body.results) && body.results.length <= 100 && body.more === false
            ? null : 'malformed';
        } };
      const result = await runs.acquire(principalId, started.runId, surface, request, adapter);
      if (!result.ok) {
        await runs.settle(started.runId, surface, result.outcome, result.reason);
        unavailable = true;
        continue;
      }
      await runs.settle(started.runId, surface, 'qualified', 'complete');
      options.afterCapture?.(surface);
    }
    await runs.complete(started.runId);
  });
  return (await runs.read(principalId, started.runId))!;
}

function surfaceOf(requestKey: string): VndbSurface {
  const surface = VNDB_CONCEPT_SURFACES.find(item => requestKey === `fixture:vndb:${item}`);
  if (!surface) throw new Error('fixture request escaped its fixed surface set');
  return surface;
}
