import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ModProfileInvalid, type ModOutcome, type ModRequest, solveModCaptures }
  from './mod-profile.ts';
import { MOD_RELEASE_COST, type ModBrowseRelease, type ModListing, modListing, type ModRelease, modRelease,
  modReleaseChannel }
  from './mod-release.ts';

export { ModProfileInvalid } from './mod-profile.ts';
export class ModResolutionConflict extends Error {}
export class ModResolutionUnavailable extends Error {}
export interface ModResolution {
  profile: 'mod-native-capture-receipt-v1' | 'mod-native-capture-receipt-v2';
  resolution: string;
  requestDigest: string;
  request: ModRequest;
  outcome: ModOutcome;
  createdAt: string;
}
export interface PublicModCard {
  profile: 'mod-work-card-v1';
  game: 'Minecraft';
  gameVersions: string[];
  loaders: Array<'Fabric' | 'Forge' | 'NeoForge'>;
  latestRelease: string | null;
  capturedAt: string;
}

/** The v1 card of one release: its game version, loader and version. */
const latestCard = (release: ModRelease): PublicModCard => ({ profile: 'mod-work-card-v1', game: 'Minecraft',
  gameVersions: release.gameVersions, loaders: release.loaders, latestRelease: release.version,
  capturedAt: release.capturedAt });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
interface Row { id: string; principal_id: string; idempotency_key: string;
  request_digest: string; request: ModRequest; outcome: ModOutcome; created_at: Date }

/** One indexed insert and exact read per write; bounded indexed reads per listing or page. */
export class ModResolutionStore {
  constructor(private readonly pool: Pool, private readonly accessPool?: Pool) {}

  /** One verified private receipt yields only declared game, loader and release facts. */
  static card(receipt: ModResolution): PublicModCard {
    return latestCard(modRelease(receipt));
  }

  /**
   * O(1) indexed writes and reads: the receipt's owner lists it as a release of
   * a Work. A receipt belongs to one Work, and a Work lists each version, loader
   * and game version once; replaying the same binding returns the same card.
   */
  async bind(principalId: string, resolutionId: string, work: string, changelog: string | null = null):
    Promise<PublicModCard> {
    if (!this.accessPool || !UUID.test(principalId) || !UUID.test(resolutionId)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) {
      throw new ModProfileInvalid('invalid mod Work binding');
    }
    const receipt = await this.read(principalId, resolutionId);
    if (!receipt) throw new ModProfileInvalid('mod receipt is unavailable');
    const release = modRelease(receipt, changelog);
    await this.accessPool.query(`INSERT INTO access.mod_work_release (work, resolution_id, principal_id, release)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [work, resolutionId, principalId, JSON.stringify(release)]);
    const bound = (await this.accessPool.query<{ work: string; principal_id: string; release: ModRelease }>(
      'SELECT work, principal_id, release FROM access.mod_work_release WHERE resolution_id = $1',
      [resolutionId])).rows[0];
    if (!bound) throw new ModResolutionConflict('Work already lists this release');
    // A release bound before 815 disclosed no notes; its replay stands as it was.
    if (bound.work !== work || bound.principal_id !== principalId
      || bound.release.mod !== null && bound.release.changelog !== release.changelog) {
      throw new ModResolutionConflict('Work already binds another mod receipt');
    }
    return latestCard(release);
  }

  /** O(W) indexed seeks for a bounded Zone page: each Work's newest release as a card. */
  async readCards(works: readonly string[]): Promise<Map<string, PublicModCard>> {
    if (!this.accessPool || works.length > 20) throw new ModResolutionUnavailable('mod card owner is unavailable');
    if (!works.length) return new Map();
    const rows = (await this.accessPool.query<{ work: string; release: ModRelease }>(
      `SELECT w.work, r.release FROM unnest($1::text[]) AS w(work) CROSS JOIN LATERAL (
        SELECT release FROM access.mod_work_release r WHERE r.work = w.work
        ORDER BY bound_at DESC, release_key DESC LIMIT 1) r`, [[...new Set(works)]])).rows;
    return new Map(rows.map(row => [row.work, latestCard(row.release)]));
  }

  /**
   * O(W·R) indexed rows, W ≤ 64 Works and R ≤ 16 newest releases each: what a
   * listing shows. Only the compatibility fields leave the store.
   */
  async readListings(works: readonly string[]): Promise<Map<string, ModListing>> {
    if (!this.accessPool || works.length > MOD_RELEASE_COST.listingWorks) {
      throw new ModResolutionUnavailable('mod listing owner is unavailable');
    }
    if (!works.length) return new Map();
    const rows = (await this.accessPool.query<{ work: string; release: ModRelease; bound_at: Date }>(
      `SELECT w.work, jsonb_build_object('gameVersions', r.release->'gameVersions', 'loaders', r.release->'loaders',
        'environment', r.release->'environment', 'version', r.release->'version') AS release, r.bound_at
      FROM unnest($1::text[]) AS w(work) CROSS JOIN LATERAL (
        SELECT release, bound_at FROM access.mod_work_release r WHERE r.work = w.work
        ORDER BY bound_at DESC, release_key DESC LIMIT ${MOD_RELEASE_COST.releasesPerListing}) r
      ORDER BY w.work, r.bound_at DESC`, [[...new Set(works)]])).rows;
    const grouped = new Map<string, { release: ModRelease; boundAt: string }[]>();
    for (const row of rows) {
      grouped.set(row.work, [...grouped.get(row.work) ?? [], { release: row.release, boundAt: row.bound_at.toISOString() }]);
    }
    return new Map([...grouped].flatMap(([work, releases]) => {
      const listing = modListing(releases);
      return listing ? [[work, listing] as const] : [];
    }));
  }

  /**
   * One indexed seek per Work and at most W × (R + 1) rows (W ≤ 64, R ≤ 128).
   * A truncated history fails closed: a release beyond the window could change
   * compatibility or a Facet count. Only fields needed for browse cross Access.
   */
  async readBrowseListings(works: readonly string[]): Promise<Map<string, {
    listing: ModListing; releases: ModBrowseRelease[] }>> {
    if (!this.accessPool || works.length > MOD_RELEASE_COST.listingWorks) {
      throw new ModResolutionUnavailable('mod browse owner is unavailable');
    }
    if (!works.length) return new Map();
    const rows = (await this.accessPool.query<{ work: string; release: ModBrowseRelease; bound_at: Date }>(
      `SELECT w.work, jsonb_build_object('version', r.release->'version',
        'gameVersions', r.release->'gameVersions', 'loaders', r.release->'loaders',
        'environment', r.release->'environment', 'dependencies', r.release->'dependencies') AS release,
        r.bound_at, r.release_key
      FROM unnest($1::text[]) AS w(work) CROSS JOIN LATERAL (
        SELECT release, bound_at, release_key FROM access.mod_work_release r WHERE r.work = w.work
        ORDER BY bound_at DESC, release_key DESC LIMIT ${MOD_RELEASE_COST.browseReleasesPerWork + 1}) r
      ORDER BY w.work, r.bound_at DESC, r.release_key DESC`, [[...new Set(works)]])).rows;
    const grouped = new Map<string, { release: ModBrowseRelease; boundAt: string }[]>();
    for (const row of rows) {
      const group = grouped.get(row.work) ?? [];
      group.push({ release: { ...row.release, publishedAt: row.bound_at.toISOString() },
        boundAt: row.bound_at.toISOString() });
      grouped.set(row.work, group);
    }
    const result = new Map<string, { listing: ModListing; releases: ModBrowseRelease[] }>();
    for (const [work, group] of grouped) {
      if (group.length > MOD_RELEASE_COST.browseReleasesPerWork) {
        throw new ModResolutionUnavailable('mod browse release history exceeds its read budget');
      }
      const listing = modListing(group.slice(0, MOD_RELEASE_COST.releasesPerListing));
      if (listing) result.set(work, { listing, releases: group.map(item => item.release) });
    }
    return result;
  }

  /** One indexed page of at most 20 releases, newest first, continuing after `(boundAt, key)`. */
  async readReleases(work: string, limit: number, after?: { boundAt: string; key: string }) {
    if (!this.accessPool) throw new ModResolutionUnavailable('mod release owner is unavailable');
    if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work) || !Number.isInteger(limit) || limit < 1
      || limit > MOD_RELEASE_COST.pageSize) throw new ModProfileInvalid('invalid mod release page');
    // The cursor keeps the stored microseconds (`bound_at::text`), which an ISO string would round away.
    const rows = (await this.accessPool.query<{ release: ModRelease; bound_at: Date; bound_key: string;
      release_key: string }>(
      `SELECT release, bound_at, bound_at::text AS bound_key, release_key FROM access.mod_work_release WHERE work = $1
        ${after ? 'AND (bound_at, release_key) < ($3::timestamptz, $4::text)' : ''}
      ORDER BY bound_at DESC, release_key DESC LIMIT $2`,
    [work, limit + 1, ...after ? [after.boundAt, after.key] : []])).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page.map(row => ({ ...row.release, publishedAt: row.bound_at.toISOString(),
      channel: modReleaseChannel(row.release.version) })),
      next: rows.length > limit && last ? { boundAt: last.bound_key, key: last.release_key } : null };
  }
  private verified(row: Row): ModResolution {
    if (row.request_digest !== digest(row.request)
      || stable(row.outcome) !== stable(solveModCaptures(row.request))) {
      throw new ModResolutionUnavailable('stored mod receipt differs from its capture');
    }
    return { profile: row.request.profile === 'mod-native-capture-v2'
      ? 'mod-native-capture-receipt-v2' : 'mod-native-capture-receipt-v1',
      resolution: `https://rezics.com/id/${row.id}`, requestDigest: row.request_digest,
      request: row.request, outcome: row.outcome, createdAt: row.created_at.toISOString() };
  }
  async resolve(principalId: string, key: string, request: ModRequest):
    Promise<{ resolution: ModResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new ModProfileInvalid('invalid mod key');
    const outcome = solveModCaptures(request);
    const requestDigest = digest(request);
    const inserted = await this.pool.query(`INSERT INTO pkg.mod_resolution
      (id, principal_id, idempotency_key, request_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, requestDigest,
      JSON.stringify(request), JSON.stringify(outcome)]);
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.mod_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
    if (!row || row.request_digest !== requestDigest) {
      throw new ModResolutionConflict('mod idempotency key binds another capture');
    }
    return { resolution: this.verified(row), replayed: inserted.rowCount === 0 };
  }
  async read(principalId: string, id: string): Promise<ModResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(id)) throw new ModProfileInvalid('invalid mod identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.mod_resolution
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
