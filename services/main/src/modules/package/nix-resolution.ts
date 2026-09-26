import type { Pool } from 'pg';
import { observeNixFlake } from './nix-adapter.ts';
import { admitNixRequest, digest, NixResolutionConflict, NixResolutionInvalid,
  NixResolutionUnavailable, parseNixLock, stable, type NixOutcome, type NixRequest }
  from './nix-graph.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;

export interface NixResolution {
  profile: 'nix-flake-native-receipt-v1';
  resolution: string;
  requestDigest: string;
  request: NixRequest;
  outcome: NixOutcome;
  createdAt: string;
}
interface Row {
  id: string; principal_id: string; idempotency_key: string;
  request_digest: string; outcome_digest: string;
  request: NixRequest; outcome: NixOutcome; created_at: Date;
}

/**
 * Cost: indexed owner read and insert, O(B + V + E + D + C) local verification,
 * one native evaluation/build capped at 30 s, 1 CPU and 1 GiB on first write.
 * B <= 256 KiB, V <= 32, E <= 64, D <= 64 and C <= 256. Replay/read run no Nix.
 */
export class NixResolutionStore {
  constructor(private readonly pool: Pool,
    private readonly evaluate: (request: NixRequest) => Promise<NixOutcome> = observeNixFlake) {}

  private verified(row: Row): NixResolution {
    try {
      admitNixRequest(row.request);
      if (row.request_digest !== digest(row.request) || row.outcome_digest !== digest(row.outcome)) {
        throw new Error('Nix receipt digest changed');
      }
      const expected = parseNixLock(row.request.flakeLock);
      const observed = row.outcome.inputGraph;
      if (expected.root !== observed.root || stable(expected.edges) !== stable(observed.edges)
        || stable(expected.nodes.map(({ id, original, locked }) => ({ id, original, locked })))
          !== stable(observed.nodes.map(({ id, original, locked }) => ({ id, original, locked })))) {
        throw new Error('Nix input graph differs from locked request');
      }
      if (observed.nodes.some((node, index) => expected.nodes[index]?.sourceHash !== null
        && expected.nodes[index]?.sourceHash !== node.sourceHash)) {
        throw new Error('Nix locked source hash differs');
      }
      if (row.outcome.status === 'observed' && (row.outcome.runtimeClosure.status !== 'observed'
        || !row.outcome.derivationGraph || observed.nodes.some(node => node.sourceHash === null))) {
        throw new Error('Nix observed status lacks complete graphs and hashes');
      }
      return { profile: 'nix-flake-native-receipt-v1',
        resolution: `https://rezics.com/id/${row.id}`, requestDigest: row.request_digest,
        request: row.request, outcome: row.outcome, createdAt: row.created_at.toISOString() };
    } catch { throw new NixResolutionUnavailable('stored Nix receipt is unavailable'); }
  }

  async resolve(principalId: string, key: string, request: NixRequest):
    Promise<{ resolution: NixResolution; replayed: boolean }> {
    if (!UUID.test(principalId) || !KEY.test(key)) throw new NixResolutionInvalid('invalid Nix key');
    admitNixRequest(request);
    const requestDigest = digest(request);
    const prior = await this.row(principalId, key);
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new NixResolutionConflict('Nix key binds another request');
      return { resolution: this.verified(prior), replayed: true };
    }
    const outcome = await this.evaluate(request);
    const inserted = await this.pool.query(`INSERT INTO pkg.nix_resolution
      (id, principal_id, idempotency_key, request_digest, outcome_digest, request, outcome)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
    [Bun.randomUUIDv7(), principalId, key, requestDigest, digest(outcome),
      JSON.stringify(request), JSON.stringify(outcome)]);
    const row = await this.row(principalId, key);
    if (!row || row.request_digest !== requestDigest) {
      throw new NixResolutionConflict('Nix key binds another request');
    }
    return { resolution: this.verified(row), replayed: inserted.rowCount !== 1 };
  }

  private async row(principalId: string, key: string): Promise<Row | undefined> {
    return (await this.pool.query<Row>(`SELECT * FROM pkg.nix_resolution
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
  }

  async read(principalId: string, id: string): Promise<NixResolution | null> {
    if (!UUID.test(principalId) || !UUID.test(id)) throw new NixResolutionInvalid('invalid Nix identity');
    const row = (await this.pool.query<Row>(`SELECT * FROM pkg.nix_resolution
      WHERE id = $1 AND principal_id = $2`, [id, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }
}
