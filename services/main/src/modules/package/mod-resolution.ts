import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ModProfileInvalid, type ModOutcome, type ModRequest, solveModCaptures }
  from './mod-profile.ts';

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

/** One indexed insert and exact read per write; one indexed row per read. */
export class ModResolutionStore {
  constructor(private readonly pool: Pool, private readonly accessPool?: Pool) {}

  /** One verified private receipt yields only declared game, loader and release facts. */
  static card(receipt: ModResolution): PublicModCard {
    const { request, outcome } = receipt;
    if (outcome.selection !== 'valid' || outcome.ordering !== 'valid'
      || !['fabric', 'forge', 'neoforge'].includes(request.ecosystem)
      || !request.runtime?.gameVersion || request.runtime.gameVersion.length > 32) {
      throw new ModProfileInvalid('Only a valid Minecraft capture with a game version can be bound');
    }
    const root = request.captures.find(capture => capture.identity === request.root
      && capture.surface === 'manifest' && capture.status === 'observed');
    let latestRelease: string | null = null;
    if (root?.bytesBase64) {
      const raw = Buffer.from(root.bytesBase64, 'base64').toString('utf8');
      const document = request.ecosystem === 'fabric' ? JSON.parse(raw) as { version?: unknown }
        : Bun.TOML.parse(raw) as { mods?: Array<{ modId?: unknown; version?: unknown }> };
      const version = request.ecosystem === 'fabric' ? (document as { version?: unknown }).version
        : (document as { mods?: Array<{ modId?: unknown; version?: unknown }> }).mods
          ?.find(mod => mod.modId === request.root)?.version;
      if (typeof version === 'string' && version.length <= 64 && !version.includes('${')) {
        latestRelease = version;
      }
    }
    const loader = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' } as const;
    return { profile: 'mod-work-card-v1', game: 'Minecraft',
      gameVersions: [request.runtime.gameVersion],
      loaders: [loader[request.ecosystem as keyof typeof loader]],
      latestRelease, capturedAt: receipt.createdAt };
  }

  /** O(1) indexed binding; only the receipt owner can nominate a Work. */
  async bind(principalId: string, resolutionId: string, work: string): Promise<PublicModCard> {
    if (!this.accessPool || !UUID.test(principalId) || !UUID.test(resolutionId)
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(work)) {
      throw new ModProfileInvalid('invalid mod Work binding');
    }
    const receipt = await this.read(principalId, resolutionId);
    if (!receipt) throw new ModProfileInvalid('mod receipt is unavailable');
    const card = ModResolutionStore.card(receipt);
    await this.accessPool.query(`INSERT INTO access.mod_work_binding (work, resolution_id, principal_id, card)
      VALUES ($1,$2,$3,$4) ON CONFLICT (work) DO NOTHING`,
    [work, resolutionId, principalId, JSON.stringify(card)]);
    const bound = (await this.accessPool.query<{ resolution_id: string; principal_id: string }>(
      'SELECT resolution_id, principal_id FROM access.mod_work_binding WHERE work = $1', [work])).rows[0];
    if (bound?.resolution_id !== resolutionId || bound.principal_id !== principalId) {
      throw new ModResolutionConflict('Work already binds another mod receipt');
    }
    return card;
  }

  /** O(W) indexed lookups for a bounded Zone page; no private capture is returned. */
  async readCards(works: readonly string[]): Promise<Map<string, PublicModCard>> {
    if (!this.accessPool || works.length > 20) throw new ModResolutionUnavailable('mod card owner is unavailable');
    if (!works.length) return new Map();
    const rows = (await this.accessPool.query<{ work: string; card: PublicModCard }>(
      'SELECT work, card FROM access.mod_work_binding WHERE work = ANY($1::text[]) LIMIT 21',
      [works])).rows;
    if (rows.length > 20) throw new ModResolutionUnavailable('mod card batch exceeds its budget');
    return new Map(rows.map(row => [row.work, row.card]));
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
