import type { Pool, PoolClient } from 'pg';
import type { GoProxyCaptureStore }
  from './go-proxy-capture.ts';
import { fetchGoSumdbLatestEvidence, type SignedGoSumdbHead,
  type IncludedGoSumdbLookup,
  validateIncludedGoSumdbLookup, verifyGoSumdbLookup,
  verifyGoSumdbTreeConsistency } from './go-sumdb-lookup.ts';
import { verifyGoSumdbTreeNote, type VerifiedGoSumdbTreeNote }
  from './go-sumdb-note.ts';

export class GoSumdbTrustInvalid extends Error {}
export class GoSumdbTrustConflict extends Error {}
export class GoSumdbTrustUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const INITIAL_SIZE = 65_209_736;
const INITIAL_ROOT = '5+uGFjx6xBZG8ip1+wi77v+grwbhhukIrxEUS8PXvRo=';

interface HeadRow {
  history_id: string; tree_size: string; root_hash: string; signed_note: Buffer;
}
interface VerificationRow {
  id: string; principal_id: string; idempotency_key: string;
  capture_id: string; capture_mod_sha256: string;
  evidence: IncludedGoSumdbLookup; trusted_head_id: string; created_at: Date;
  trusted_tree_size: string; trusted_root_hash: string; trusted_signed_note: Buffer;
}

export interface GoSumdbVerificationResult {
  profile: 'go-sumdb-capture-verification-v1';
  verification: string;
  capture: string;
  path: string;
  version: string;
  manifestSha256: string;
  goModH1: string;
  recordIndex: number;
  recordSha256: string;
  includedTree: VerifiedGoSumdbTreeNote;
  trustedTree: VerifiedGoSumdbTreeNote;
  createdAt: string;
}

type Lookup = typeof verifyGoSumdbLookup;
type Consistency = typeof verifyGoSumdbTreeConsistency;
type Latest = typeof fetchGoSumdbLatestEvidence;

function checkedHead(row: HeadRow): VerifiedGoSumdbTreeNote {
  const tree = verifyGoSumdbTreeNote(row.signed_note);
  if (tree.size !== Number(row.tree_size) || tree.rootHash !== row.root_hash) {
    throw new GoSumdbTrustUnavailable('stored Go checksum head differs');
  }
  return tree;
}

function initialHead(tree: VerifiedGoSumdbTreeNote): void {
  if (tree.size < INITIAL_SIZE
    || (tree.size === INITIAL_SIZE && tree.rootHash !== INITIAL_ROOT)) {
    throw new GoSumdbTrustUnavailable('Go checksum head precedes pinned baseline');
  }
}

export class GoSumdbTrustStore {
  constructor(private readonly pool: Pool,
    private readonly captures: GoProxyCaptureStore,
    private readonly lookup: Lookup = verifyGoSumdbLookup,
    private readonly consistency: Consistency = verifyGoSumdbTreeConsistency,
    private readonly latest: Latest = fetchGoSumdbLatestEvidence) {}

  private async existing(principalId: string, key: string): Promise<VerificationRow | null> {
    const row = (await this.pool.query<VerificationRow>(`SELECT v.*,
      h.tree_size AS trusted_tree_size, h.root_hash AS trusted_root_hash,
      h.signed_note AS trusted_signed_note
      FROM pkg.go_sumdb_verification v
      JOIN pkg.go_sumdb_head_history h ON h.id = v.trusted_head_id
      WHERE v.principal_id = $1 AND v.idempotency_key = $2`,
    [principalId, key])).rows[0];
    return row ?? null;
  }

  private async verified(row: VerificationRow): Promise<GoSumdbVerificationResult> {
    const capture = await this.captures.read(row.principal_id, row.capture_id);
    if (!capture || capture.manifest.rawSha256 !== row.capture_mod_sha256) {
      throw new GoSumdbTrustUnavailable('Go checksum capture evidence differs');
    }
    let trustedTree: VerifiedGoSumdbTreeNote;
    try {
      validateIncludedGoSumdbLookup(row.evidence,
        { path: capture.path, version: capture.version }, capture.manifest.goModH1);
      trustedTree = checkedHead({ history_id: row.trusted_head_id,
        tree_size: row.trusted_tree_size, root_hash: row.trusted_root_hash,
        signed_note: row.trusted_signed_note });
    } catch {
      throw new GoSumdbTrustUnavailable('stored Go checksum proof differs');
    }
    if (trustedTree.size < row.evidence.tree.size
      || (trustedTree.size === row.evidence.tree.size
        && trustedTree.rootHash !== row.evidence.tree.rootHash)) {
      throw new GoSumdbTrustUnavailable('Go checksum receipt head differs');
    }
    return { profile: 'go-sumdb-capture-verification-v1',
      verification: `https://rezics.com/id/${row.id}`,
      capture: capture.capture, path: capture.path, version: capture.version,
      manifestSha256: capture.manifest.rawSha256,
      goModH1: capture.manifest.goModH1,
      recordIndex: row.evidence.recordIndex,
      recordSha256: row.evidence.recordSha256,
      includedTree: row.evidence.tree, trustedTree,
      createdAt: row.created_at.toISOString() };
  }

  async read(principalId: string, verificationId: string):
    Promise<GoSumdbVerificationResult | null> {
    if (!UUID.test(principalId) || !UUID.test(verificationId)) {
      throw new GoSumdbTrustInvalid('invalid Go checksum verification identity');
    }
    const row = (await this.pool.query<VerificationRow>(`SELECT v.*,
      h.tree_size AS trusted_tree_size, h.root_hash AS trusted_root_hash,
      h.signed_note AS trusted_signed_note
      FROM pkg.go_sumdb_verification v
      JOIN pkg.go_sumdb_head_history h ON h.id = v.trusted_head_id
      WHERE v.id = $1 AND v.principal_id = $2`,
    [verificationId, principalId])).rows[0];
    return row ? this.verified(row) : null;
  }

  async verify(principalId: string, key: string, captureId: string):
    Promise<{ verification: GoSumdbVerificationResult; replayed: boolean } | null> {
    if (!UUID.test(principalId) || !UUID.test(captureId) || !KEY.test(key)) {
      throw new GoSumdbTrustInvalid('invalid Go checksum verification request');
    }
    const prior = await this.existing(principalId, key);
    if (prior) {
      if (prior.capture_id !== captureId) {
        throw new GoSumdbTrustConflict('Go checksum key binds another capture');
      }
      return { verification: await this.verified(prior), replayed: true };
    }
    const capture = await this.captures.read(principalId, captureId);
    if (!capture) return null;
    let included: IncludedGoSumdbLookup;
    let candidate: SignedGoSumdbHead;
    try {
      included = await this.lookup({ path: capture.path, version: capture.version },
        capture.manifest.goModH1);
      validateIncludedGoSumdbLookup(included,
        { path: capture.path, version: capture.version }, capture.manifest.goModH1);
      const latest = await this.latest();
      const note = Buffer.from(latest.signedNoteBase64, 'base64');
      if (note.toString('base64') !== latest.signedNoteBase64) {
        throw new GoSumdbTrustUnavailable('Go checksum latest note encoding differs');
      }
      const latestTree = verifyGoSumdbTreeNote(note);
      if (latestTree.size !== latest.tree.size
        || latestTree.rootHash !== latest.tree.rootHash
        || latestTree.noteSha256 !== latest.tree.noteSha256) {
        throw new GoSumdbTrustUnavailable('Go checksum latest note differs');
      }
      initialHead(latestTree);
      if (latestTree.size < included.tree.size) {
        await this.consistency(latestTree, included.tree);
        candidate = { tree: included.tree,
          signedNoteBase64: included.signedNoteBase64 };
      } else {
        candidate = latest;
      }
      await this.consistency(included.tree, candidate.tree);
    } catch (error) {
      throw new GoSumdbTrustUnavailable(`Go checksum inclusion unavailable: ${
        error instanceof Error ? error.message : 'unknown error'}`);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      const observed = (await this.pool.query<HeadRow>(`SELECT history_id, tree_size,
        root_hash, signed_note FROM pkg.go_sumdb_head
        WHERE server = 'sum.golang.org'`)).rows[0] ?? null;
      let consistencyTilePaths: string[] = [];
      let advance = !observed;
      if (observed) {
        const old = checkedHead(observed);
        try {
        if (old.size <= candidate.tree.size) {
          consistencyTilePaths = await this.consistency(old, candidate.tree);
          advance = old.size < candidate.tree.size;
        } else {
          await this.consistency(candidate.tree, old);
          advance = false;
          }
        } catch (error) {
          throw new GoSumdbTrustUnavailable(`Go checksum timeline differs: ${
            error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      const client: PoolClient = await this.pool.connect();
      let retry = false;
      try {
        await client.query('BEGIN');
        const current = (await client.query<HeadRow>(`SELECT history_id, tree_size,
          root_hash, signed_note FROM pkg.go_sumdb_head
          WHERE server = 'sum.golang.org' FOR UPDATE`)).rows[0] ?? null;
        if ((current?.history_id ?? null) !== (observed?.history_id ?? null)) {
          retry = true;
        } else {
          let trustedHeadId = current?.history_id;
          if (advance) {
            trustedHeadId = Bun.randomUUIDv7();
            await client.query(`INSERT INTO pkg.go_sumdb_head_history
              (id, previous_id, tree_size, root_hash, signed_note,
               consistency_tile_paths) VALUES ($1,$2,$3,$4,$5,$6)`,
            [trustedHeadId, current?.history_id ?? null, candidate.tree.size,
              candidate.tree.rootHash, Buffer.from(candidate.signedNoteBase64, 'base64'),
              consistencyTilePaths]);
            if (current) {
              await client.query(`UPDATE pkg.go_sumdb_head SET history_id = $1,
                tree_size = $2, root_hash = $3, signed_note = $4,
                updated_at = clock_timestamp() WHERE server = 'sum.golang.org'`,
              [trustedHeadId, candidate.tree.size, candidate.tree.rootHash,
                Buffer.from(candidate.signedNoteBase64, 'base64')]);
            } else {
              const insert = await client.query(`INSERT INTO pkg.go_sumdb_head
                (server, history_id, tree_size, root_hash, signed_note)
                VALUES ('sum.golang.org',$1,$2,$3,$4)
                ON CONFLICT DO NOTHING`, [trustedHeadId, candidate.tree.size,
                  candidate.tree.rootHash,
                  Buffer.from(candidate.signedNoteBase64, 'base64')]);
              if (insert.rowCount !== 1) retry = true;
            }
          }
          if (!retry) {
            const inserted = await client.query(`INSERT INTO pkg.go_sumdb_verification
              (id, principal_id, idempotency_key, capture_id,
               capture_mod_sha256, evidence, trusted_head_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [Bun.randomUUIDv7(), principalId, key, captureId,
              capture.manifest.rawSha256, included, trustedHeadId]);
            if (inserted.rowCount !== 1) retry = true;
          }
        }
        if (retry) await client.query('ROLLBACK');
        else await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      if (!retry) {
        const row = await this.existing(principalId, key);
        if (!row) throw new GoSumdbTrustUnavailable('Go checksum receipt disappeared');
        return { verification: await this.verified(row), replayed: false };
      }
      const won = await this.existing(principalId, key);
      if (won) {
        if (won.capture_id !== captureId) {
          throw new GoSumdbTrustConflict('Go checksum key binds another capture');
        }
        return { verification: await this.verified(won), replayed: true };
      }
    }
    throw new GoSumdbTrustUnavailable('Go checksum head changed during verification');
  }
}
