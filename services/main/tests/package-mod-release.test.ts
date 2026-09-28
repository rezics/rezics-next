import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { solveModCaptures, type ModCapture, type ModRequest } from '../src/modules/package/mod-profile.ts';
import { MOD_RELEASE_COST, modListing, type ModRelease, modRelease, newestVersionsFirst }
  from '../src/modules/package/mod-release.ts';
import { ModProfileInvalid, ModResolutionConflict, ModResolutionStore, ModResolutionUnavailable }
  from '../src/modules/package/mod-resolution.ts';

const capture = (identity: string, text: string): ModCapture => {
  const bytes = Buffer.from(text);
  return { identity, surface: 'manifest', status: 'observed', bytesBase64: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
};
const fabric = (id: string, version: string, extra: Record<string, unknown> = {}) =>
  capture(id, JSON.stringify({ schemaVersion: 1, id, version, ...extra }));

function receipt(request: ModRequest) {
  return { request, outcome: solveModCaptures(request), createdAt: '2026-09-28T00:00:00.000Z' };
}

const lanterns: ModRequest = { profile: 'mod-native-capture-v1', ecosystem: 'fabric', side: 'CLIENT',
  root: 'lumenlanterns', runtime: { loaderVersion: '0.16.10', gameVersion: '1.21.1' },
  captures: [fabric('lumenlanterns', '1.3.0', { environment: 'client',
    depends: { minecraft: '~1.21', fabricloader: '>=0.15', 'fabric-api': '>=0.100.0' },
    recommends: { modmenu: '*' }, breaks: { optifabric: '*' } }),
  fabric('fabric-api', '0.102.0', {})] };

test('a release discloses its version, where it runs and what it declares it needs, never its captures', () => {
  const release = modRelease(receipt(lanterns), '  Warmer light.\r\nFixes flicker.  ');
  expect(release).toEqual({ profile: 'mod-release-v1', mod: { id: 'lumenlanterns', ecosystem: 'fabric' },
    version: '1.3.0', game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], environment: 'client',
    dependencies: [
      { id: 'fabric-api', requirement: 'required', range: '>=0.100.0', side: 'client' },
      { id: 'modmenu', requirement: 'optional', range: null, side: 'client' },
      { id: 'optifabric', requirement: 'incompatible', range: null, side: 'client' },
    ], changelog: 'Warmer light.\nFixes flicker.', capturedAt: '2026-09-28T00:00:00.000Z' });
  // The game and loader the release runs on are compatibility, not dependencies.
  expect(release.dependencies!.map(item => item.id)).not.toContain('minecraft');
  expect(JSON.stringify(release)).not.toContain('bytesBase64');
});

test('a Forge release is client-side only when its manifest says so, and otherwise does not claim a side', () => {
  const forge = (clientSideOnly: boolean): ModRequest => ({ profile: 'mod-native-capture-v1', ecosystem: 'forge',
    side: 'CLIENT', root: 'quietvillagers', runtime: { loaderVersion: '52', gameVersion: '1.21.1' },
    captures: [capture('quietvillagers', `modLoader="javafml"\nloaderVersion="[52,)"\nlicense="MIT"\n${
      clientSideOnly ? 'clientSideOnly=true\n' : ''}[[mods]]\nmodId="quietvillagers"\nversion="1.0.2"\n`)] });
  expect(modRelease(receipt(forge(true)))).toMatchObject({ loaders: ['Forge'], version: '1.0.2',
    environment: 'client', dependencies: [], changelog: null });
  expect(modRelease(receipt(forge(false))).environment).toBeNull();
});

test('only a valid capture with short notes becomes a release', () => {
  const missing = receipt({ ...lanterns, captures: lanterns.captures.slice(0, 1) });
  expect(missing.outcome.selection).toBe('incomplete-source-data');
  expect(() => modRelease(missing)).toThrow(ModProfileInvalid);
  expect(() => modRelease(receipt(lanterns), 'x'.repeat(MOD_RELEASE_COST.changelogCharacters + 1)))
    .toThrow(ModProfileInvalid);
});

const release = (version: string, gameVersion: string, loader: ModRelease['loaders'][number]): ModRelease => ({
  profile: 'mod-release-v1', mod: null, version, game: 'Minecraft', gameVersions: [gameVersion], loaders: [loader],
  environment: 'client-and-server', dependencies: null, changelog: null, capturedAt: '2026-09-01T00:00:00.000Z' });

test('a listing folds releases into every game version and loader, newest release first', () => {
  expect(['1.20.1', '1.21.10', '1.21.9', '1.21'].sort(newestVersionsFirst)).toEqual(['1.21.10', '1.21.9', '1.21', '1.20.1']);
  expect(modListing([{ release: release('1.3.0', '1.21.1', 'Fabric'), boundAt: '2026-09-28T00:00:00.000Z' },
    { release: release('1.2.0', '1.20.1', 'Forge'), boundAt: '2026-08-01T00:00:00.000Z' },
    { release: release('1.2.0', '1.20.1', 'Fabric'), boundAt: '2026-08-01T00:00:00.000Z' }])).toEqual({
    profile: 'mod-work-card-v2', game: 'Minecraft', gameVersions: ['1.21.1', '1.20.1'], loaders: ['Fabric', 'Forge'],
    environment: 'client-and-server', latestRelease: '1.3.0', updatedAt: '2026-09-28T00:00:00.000Z' });
  expect(modListing([])).toBeNull();
});

/** A pool that answers by statement and counts them, so each read's statement budget is exact. */
function pools(answer: (sql: string, values: unknown[]) => unknown[]) {
  const statements: string[] = [];
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    return { rows: answer(sql, values), rowCount: 1 };
  } } as unknown as Pool;
  return { pool, statements };
}
const work = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const principal = '00000000-0000-4000-8000-00000000000a';
const resolution = '00000000-0000-4000-8000-00000000000b';

test('card, listing and release reads are one bounded statement each', async () => {
  const at = new Date('2026-09-28T00:00:00.000Z');
  const { pool, statements } = pools(sql => sql.includes('jsonb_build_object')
    ? [{ work, release: release('1.3.0', '1.21.1', 'Fabric'), bound_at: at }]
    : sql.includes('LIMIT 1)') ? [{ work, release: release('1.3.0', '1.21.1', 'Fabric') }]
      : [1, 2, 3].map(n => ({ release: release(`1.${n}.0`, '1.21.1', 'Fabric'), bound_at: at,
        bound_key: `2026-09-2${n} 00:00:00.123456+00`, release_key: `key-${n}` })));
  const store = new ModResolutionStore(pool, pool);
  expect(await store.readCards([work, work])).toEqual(new Map([[work, { profile: 'mod-work-card-v1',
    game: 'Minecraft', gameVersions: ['1.21.1'], loaders: ['Fabric'], latestRelease: '1.3.0',
    capturedAt: '2026-09-01T00:00:00.000Z' }]]));
  expect((await store.readListings([work])).get(work)).toMatchObject({ profile: 'mod-work-card-v2',
    updatedAt: at.toISOString() });
  const page = await store.readReleases(work, 2);
  expect(page.items.map(item => item.version)).toEqual(['1.1.0', '1.2.0']);
  // The cursor keeps the stored microseconds and the release key; no receipt id leaves the store.
  expect(page.next).toEqual({ boundAt: '2026-09-22 00:00:00.123456+00', key: 'key-2' });
  await store.readReleases(work, 2, page.next!);
  expect(statements).toHaveLength(4);
  expect(statements[1]).toContain(`LIMIT ${MOD_RELEASE_COST.releasesPerListing}`);
  expect(statements[3]).toContain('(bound_at, release_key) < ($3::timestamptz, $4::text)');
  await expect(store.readCards(Array(21).fill(work))).rejects.toBeInstanceOf(ModResolutionUnavailable);
  await expect(store.readListings(Array(MOD_RELEASE_COST.listingWorks + 1).fill(work)))
    .rejects.toBeInstanceOf(ModResolutionUnavailable);
  await expect(store.readReleases(work, MOD_RELEASE_COST.pageSize + 1)).rejects.toBeInstanceOf(ModProfileInvalid);
  expect(statements).toHaveLength(4);
});

test('binding lists a release once; another receipt for the same release or Work owner conflicts', async () => {
  const stored = new Map<string, { work: string; principal_id: string; release: ModRelease }>();
  const request = lanterns;
  const outcome = solveModCaptures(request);
  const digest = (value: unknown): string => {
    const stable = (item: unknown): string => Array.isArray(item) ? `[${item.map(stable).join(',')}]`
      : item && typeof item === 'object' ? `{${Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}` : JSON.stringify(item);
    return createHash('sha256').update(stable(value)).digest('hex');
  };
  const { pool, statements } = pools((sql, values) => {
    if (sql.includes('FROM pkg.mod_resolution')) return [{ id: values[0], principal_id: principal,
      idempotency_key: 'k', request_digest: digest(request), request, outcome,
      created_at: new Date('2026-09-28T00:00:00.000Z') }];
    if (sql.includes('INSERT INTO access.mod_work_release')) {
      const [target, id, owner, body] = values as [string, string, string, string];
      const release = JSON.parse(body) as ModRelease;
      const key = (item: ModRelease) => JSON.stringify([item.version, item.loaders, item.gameVersions]);
      const listed = [...stored.values()].some(row => row.work === target && key(row.release) === key(release));
      if (!stored.has(id) && !listed) stored.set(id, { work: target, principal_id: owner, release });
      return [];
    }
    const row = stored.get(values[0] as string);
    return row ? [row] : [];
  });
  const store = new ModResolutionStore(pool, pool);
  const card = await store.bind(principal, resolution, work, 'First light.');
  expect(card).toMatchObject({ profile: 'mod-work-card-v1', latestRelease: '1.3.0' });
  expect(statements).toHaveLength(3);
  expect(await store.bind(principal, resolution, work, 'First light.')).toEqual(card);
  await expect(store.bind(principal, resolution, work, 'Other notes.')).rejects.toBeInstanceOf(ModResolutionConflict);
  await expect(store.bind(principal, resolution, 'https://rezics.com/id/00000000-0000-4000-8000-000000000002'))
    .rejects.toBeInstanceOf(ModResolutionConflict);
  // A second receipt for a release the Work already lists is not stored (the unique release key holds).
  await expect(store.bind(principal, '00000000-0000-4000-8000-00000000000c', work))
    .rejects.toBeInstanceOf(ModResolutionConflict);
});
