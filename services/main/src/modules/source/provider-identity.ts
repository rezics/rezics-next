import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class ProviderIdentityInvalid extends Error {}
export class ProviderIdentityConflict extends Error {}
export class ProviderIdentityUnavailable extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IRI = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const iri = (id: string) => `https://rezics.com/id/${id}`;
const uuid = (value: string) => IRI.exec(value)?.[1] ?? (UUID.test(value) ? value : null);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface ChangeRow {
  id: string; principal_id: string; kind: 'redirect' | 'merge'; from_record_id: string;
  to_record_id: string; observation_id: string; evidence_pointer: string | null; created_at: Date;
  provider: string; namespace: string; from_external_id: string; to_external_id: string;
}
interface EvidenceRow {
  raw_bytes: Buffer | null; byte_digest: string | null; retention: string;
  coverage: { complete?: boolean }; to_external_id: string;
}
interface ProposalRow {
  id: string; principal_id: string; change_id: string; from_target: string; to_target: string;
  effect: 'proposal-only'; idempotency_key: string; request_digest: string; created_at: Date;
}

export interface ProviderIdentityChange {
  profile: 'source-record-identity-change-v1'; state: 'recorded'; change: string;
  kind: 'redirect' | 'merge'; fromRecord: string; toRecord: string; observation: string;
  evidencePointer: string;
  provider: string; namespace: string; fromExternalId: string; toExternalId: string;
  nativeEffect: 'none'; createdAt: string;
}
export interface ProviderIdentityCorrection {
  profile: 'source-identity-correction-proposal-v1'; state: 'proposed'; proposal: string;
  change: string; fromTarget: string; toTarget: string; effect: 'proposal-only'; createdAt: string;
}

const changeSql = `SELECT c.*, f.provider, f.namespace, f.external_id AS from_external_id,
  t.external_id AS to_external_id FROM source.record_identity_change c
  JOIN source.record f ON f.id = c.from_record_id
  JOIN source.record t ON t.id = c.to_record_id
  JOIN source.observation o ON o.id = c.observation_id
  WHERE c.id = $1 AND c.principal_id = $2 AND o.record_id = c.from_record_id
    AND o.principal_id = c.principal_id AND f.provider = t.provider AND f.namespace = t.namespace`;

function changeResult(row: ChangeRow): ProviderIdentityChange {
  if (!row.evidence_pointer) throw new ProviderIdentityUnavailable('identity evidence pointer is unavailable');
  return { profile: 'source-record-identity-change-v1', state: 'recorded', change: iri(row.id),
    kind: row.kind, fromRecord: iri(row.from_record_id), toRecord: iri(row.to_record_id),
    observation: iri(row.observation_id), evidencePointer: row.evidence_pointer,
    provider: row.provider, namespace: row.namespace,
    fromExternalId: row.from_external_id, toExternalId: row.to_external_id,
    nativeEffect: 'none', createdAt: row.created_at.toISOString() };
}

function evidenceValue(bytes: Buffer, path: string): unknown {
  if (path.length > 200 || !path.startsWith('/') || path.split('/').length > 9
    || /~(?![01])/.test(path)) throw new ProviderIdentityInvalid('invalid evidence pointer');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ProviderIdentityInvalid('identity observation is not JSON'); }
  for (const token of path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(token)) throw new ProviderIdentityInvalid('invalid evidence index');
      value = value[Number(token)];
    } else if (value && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else throw new ProviderIdentityConflict('identity evidence field is absent');
  }
  return value;
}
function correctionResult(row: ProposalRow): ProviderIdentityCorrection {
  return { profile: 'source-identity-correction-proposal-v1', state: 'proposed',
    proposal: iri(row.id), change: iri(row.change_id), fromTarget: row.from_target,
    toTarget: row.to_target, effect: row.effect, createdAt: row.created_at.toISOString() };
}

/** Indexed single-row lookups and inserts; no traversal of aliases or native grants. */
export class ProviderIdentityStore {
  constructor(private readonly pool: Pool) {}

  private async evidence(principalId: string, from: string, to: string, observation: string):
    Promise<EvidenceRow | null> {
    return (await this.pool.query<EvidenceRow>(`SELECT o.raw_bytes, o.byte_digest,
      o.retention, o.coverage, t.external_id AS to_external_id
      FROM source.observation o JOIN source.record f ON f.id = o.record_id
      JOIN source.record t ON t.id = $3 WHERE o.id = $4 AND o.principal_id = $1
        AND f.id = $2 AND t.provider = f.provider AND t.namespace = f.namespace`,
    [principalId, from, to, observation])).rows[0] ?? null;
  }

  private checkedEvidence(evidence: EvidenceRow, path: string): void {
    if (evidence.retention !== 'retained' || !evidence.raw_bytes || !evidence.byte_digest
      || !evidence.coverage.complete
      || createHash('sha256').update(evidence.raw_bytes).digest('hex') !== evidence.byte_digest) {
      throw new ProviderIdentityUnavailable('complete retained identity observation is unavailable');
    }
    if (evidenceValue(evidence.raw_bytes, path) !== evidence.to_external_id) {
      throw new ProviderIdentityConflict('retained identity value differs from destination');
    }
  }

  async record(principalId: string, input: { kind: 'redirect' | 'merge'; fromRecord: string;
    toRecord: string; observation: string; evidencePointer: string }):
    Promise<{ change: ProviderIdentityChange; replayed: boolean } | null> {
    const from = uuid(input.fromRecord), to = uuid(input.toRecord), observation = uuid(input.observation);
    if (!UUID.test(principalId) || !from || !to || !observation || from === to
      || !['redirect', 'merge'].includes(input.kind)) throw new ProviderIdentityInvalid('invalid identity change');
    const evidence = await this.evidence(principalId, from, to, observation);
    if (!evidence) return null;
    this.checkedEvidence(evidence, input.evidencePointer);
    try {
      const inserted = await this.pool.query(`INSERT INTO source.record_identity_change
        (id, principal_id, kind, from_record_id, to_record_id, observation_id, evidence_pointer)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (
          SELECT 1 FROM source.observation o JOIN source.record f ON f.id = o.record_id
          JOIN source.record t ON t.id = $5 WHERE o.id = $6 AND o.principal_id = $2
            AND o.retention = 'retained' AND o.coverage->>'complete' = 'true'
            AND f.id = $4 AND f.provider = t.provider AND f.namespace = t.namespace)
        ON CONFLICT (observation_id, from_record_id) DO NOTHING`,
      [Bun.randomUUIDv7(), principalId, input.kind, from, to, observation, input.evidencePointer]);
      const row = (await this.pool.query<ChangeRow>(`SELECT c.*, f.provider, f.namespace,
          f.external_id AS from_external_id, t.external_id AS to_external_id
          FROM source.record_identity_change c JOIN source.record f ON f.id = c.from_record_id
          JOIN source.record t ON t.id = c.to_record_id
          WHERE c.observation_id = $1 AND c.from_record_id = $2 AND c.principal_id = $3`,
      [observation, from, principalId])).rows[0];
      if (!row) return null;
      if (row.to_record_id !== to || row.kind !== input.kind
        || row.evidence_pointer !== input.evidencePointer) {
        throw new ProviderIdentityConflict('observation already binds another identity change');
      }
      return { change: changeResult(row), replayed: inserted.rowCount === 0 };
    } catch (error) {
      if (error instanceof ProviderIdentityConflict) throw error;
      if ((error as { code?: string }).code === '23514' || (error as { code?: string }).code === '23505') {
        throw new ProviderIdentityConflict('identity change conflicts with retained evidence');
      }
      throw error;
    }
  }

  async read(principalId: string, changeId: string): Promise<ProviderIdentityChange | null> {
    const id = uuid(changeId);
    if (!UUID.test(principalId) || !id) throw new ProviderIdentityInvalid('invalid identity change');
    const row = (await this.pool.query<ChangeRow>(changeSql, [id, principalId])).rows[0];
    if (!row) return null;
    const evidence = await this.evidence(principalId, row.from_record_id,
      row.to_record_id, row.observation_id);
    if (!evidence || !row.evidence_pointer) {
      throw new ProviderIdentityUnavailable('identity observation is unavailable');
    }
    try { this.checkedEvidence(evidence, row.evidence_pointer); }
    catch { throw new ProviderIdentityUnavailable('identity observation differs from recorded change'); }
    return changeResult(row);
  }

  async propose(principalId: string, key: string, input: { change: string; fromTarget: string;
    toTarget: string }): Promise<{ proposal: ProviderIdentityCorrection; replayed: boolean } | null> {
    const change = uuid(input.change);
    if (!UUID.test(principalId) || !KEY.test(key) || !change || !IRI.test(input.fromTarget)
      || !IRI.test(input.toTarget) || input.fromTarget === input.toTarget) {
      throw new ProviderIdentityInvalid('invalid identity correction proposal');
    }
    if (!await this.read(principalId, change)) return null;
    const requestDigest = digest([change, input.fromTarget, input.toTarget]);
    try {
      const inserted = await this.pool.query(`INSERT INTO source.identity_correction_proposal
        (id, principal_id, change_id, from_target, to_target, effect, idempotency_key, request_digest)
        VALUES ($1,$2,$3,$4,$5,'proposal-only',$6,$7) ON CONFLICT DO NOTHING`,
      [Bun.randomUUIDv7(), principalId, change, input.fromTarget, input.toTarget, key, requestDigest]);
      const row = (await this.pool.query<ProposalRow>(`SELECT * FROM source.identity_correction_proposal
        WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key])).rows[0];
      if (!row || row.request_digest !== requestDigest) {
        throw new ProviderIdentityConflict('key or target binds another identity correction');
      }
      return { proposal: correctionResult(row), replayed: inserted.rowCount === 0 };
    } catch (error) {
      if (error instanceof ProviderIdentityConflict) throw error;
      if (['23514', '23505'].includes((error as { code?: string }).code ?? '')) {
        throw new ProviderIdentityConflict('identity correction lacks matching source supports');
      }
      throw error;
    }
  }

  async readProposal(principalId: string, proposalId: string): Promise<ProviderIdentityCorrection | null> {
    const id = uuid(proposalId);
    if (!UUID.test(principalId) || !id) throw new ProviderIdentityInvalid('invalid identity proposal');
    const row = (await this.pool.query<ProposalRow>(`SELECT p.* FROM source.identity_correction_proposal p
      JOIN source.record_identity_change c ON c.id = p.change_id AND c.principal_id = p.principal_id
      WHERE p.id = $1 AND p.principal_id = $2`, [id, principalId])).rows[0];
    if (!row) return null;
    if (!await this.read(principalId, row.change_id)) {
      throw new ProviderIdentityUnavailable('identity change evidence is unavailable');
    }
    if (row.request_digest !== digest([row.change_id, row.from_target, row.to_target])) {
      throw new ProviderIdentityUnavailable('identity correction differs from retained intent');
    }
    return correctionResult(row);
  }
}
