import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { AccessAdmissionRegistry, VerifiedPrincipal } from '../access/admission.ts';
import type { WorkEditAuthorityProof } from '../access/work-edit-authority.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { GRAPHS, RV } from '../work/activate.ts';
import { readExactWorkRevision, type ExactWorkRevision } from '../work/history.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { FieldWithdrawalConflict, FieldWithdrawalInvalid, FieldWithdrawalUnavailable } from './withdrawal.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IRI = /^https:\/\/rezics\.com\/id\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const id = (value: string) => IRI.exec(value)?.[1] ?? (UUID.test(value) ? value : null);
const iri = (value: string) => `https://rezics.com/id/${value}`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

export interface AttachFieldSupportInput {
  profile: 'source-field-support-attachment-v1'; target: string; slot: string;
  occurrence: string | null; context: string; sourceRecord: string;
  conversion: string; grain: string; sourceField: string; sourceOccurrence: string | null;
  sourcePointer: string; expectedHead: string; actingSubject: string;
}

interface EvidenceRow {
  observation_id: string; record_id: string; provider: string; namespace: string; mapping_provider: string;
  mapping_namespace: string; mapping_grain: string; mapping_revision: string;
  source_digest: string; field_inventory: unknown; byte_digest: string | null;
  raw_bytes: Buffer | null; retention: string; coverage: { complete?: boolean };
  media_type: string; disposition: string; native_target: string | null;
}

export const fieldAttachmentEvidenceSql = `SELECT c.mapping_revision, c.source_digest, c.field_inventory,
  o.id AS observation_id, o.raw_bytes, o.byte_digest, o.retention, o.coverage, o.media_type, o.record_id,
  r.provider, r.namespace, m.provider AS mapping_provider, m.namespace AS mapping_namespace,
  m.root_grain AS mapping_grain, d.disposition, d.native_target
  FROM source.conversion c JOIN source.observation o ON o.id = c.observation_id
  JOIN source.record r ON r.id = o.record_id
  JOIN source.field_mapping m ON m.mapping_revision = c.mapping_revision
  JOIN source.field_disposition d ON d.mapping_revision = c.mapping_revision
    AND d.grain = $4 AND d.field_key = $5
  WHERE c.id = $1 AND c.principal_id = $2 AND o.record_id = $3
    AND o.principal_id = c.principal_id`;

/** Only verified native owner slots may be named. New fields add an adapter, not a new support flow. */
const nativeSlotValue: Record<string, (revision: ExactWorkRevision) => unknown> = {
  'work-metadata-v1#semantic-types': revision => revision.semanticTypes,
  'work-metadata-v1#scalar-value': revision => revision.scalarValue,
};

export function fieldValueAtPointer(bytes: Buffer, path: string): unknown {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new FieldWithdrawalInvalid('source field observation is not JSON'); }
  return valueAtPointer(value, path);
}

function valueAtPointer(root: unknown, path: string): unknown {
  if (path.length > 200 || !path.startsWith('/') || path.split('/').length > 9
    || /~(?![01])/.test(path)) throw new FieldWithdrawalInvalid('invalid source field pointer');
  let value = root;
  for (const token of path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]{0,5})$/.test(token)) throw new FieldWithdrawalInvalid('invalid source array index');
      value = value[Number(token)];
    } else if (value && typeof value === 'object' && Object.hasOwn(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else throw new FieldWithdrawalConflict('source field pointer is absent');
  }
  return value;
}

/** Observation and JSON position identify source evidence; they never identify a native child. */
export function sourceFieldOccurrence(observation: string, grain: string,
  field: string, pointer: string): string {
  if (!IRI.test(observation) || !grain || !field || !pointer.startsWith('/')) {
    throw new FieldWithdrawalInvalid('invalid source child occurrence basis');
  }
  return `urn:rezics:source-occurrence:${hash(JSON.stringify({ observation, grain, field, pointer }))}`;
}

export function checkedFieldEvidence(row: EvidenceRow | undefined, input: Pick<AttachFieldSupportInput,
  'slot' | 'grain' | 'sourceField' | 'sourcePointer' | 'sourceOccurrence' | 'occurrence'>):
  { digest: string; mapping: string } {
  if (!row || row.retention !== 'retained' || !row.raw_bytes || !row.byte_digest
    || !row.coverage.complete || !/^application\/json(?:;|$)/i.test(row.media_type)
    || hash(row.raw_bytes) !== row.byte_digest || row.source_digest !== row.byte_digest
    || row.provider !== row.mapping_provider || row.namespace !== row.mapping_namespace
    || row.mapping_grain !== input.grain || row.native_target !== input.slot
    || !['native', 'lossy'].includes(row.disposition)) {
    throw new FieldWithdrawalUnavailable('complete mapped source field is unavailable');
  }
  if (!Array.isArray(row.field_inventory) || !row.field_inventory.some(item => item
    && typeof item === 'object' && (item as Record<string, unknown>).grain === input.grain
    && (item as Record<string, unknown>).field === input.sourceField
    && (item as Record<string, unknown>).disposition === row.disposition)) {
    throw new FieldWithdrawalUnavailable('source field is absent from conversion inventory');
  }
  if (input.occurrence === null ? input.sourceOccurrence !== null
    : input.sourceOccurrence !== sourceFieldOccurrence(iri(row.observation_id),
      input.grain, input.sourceField, input.sourcePointer)) {
    throw new FieldWithdrawalConflict('source child occurrence differs from retained position');
  }
  const value = fieldValueAtPointer(row.raw_bytes, input.sourcePointer);
  if (value === undefined || JSON.stringify(value) === undefined) {
    throw new FieldWithdrawalInvalid('source field has no retained value');
  }
  return { digest: hash(JSON.stringify(value)), mapping: row.mapping_revision };
}

export async function checkedFieldNativeValue(env: WorkActivationEnvironment, input: Pick<AttachFieldSupportInput,
  'target' | 'slot' | 'expectedHead' | 'occurrence' | 'context'>, valueDigest: string,
  requireCurrent = false): Promise<void> {
  if (input.occurrence !== null) {
    // The Structure owner resolves one exact occurrence through its indexed
    // record tree. The path depth is capped at six; no child list is scanned.
    const path = /^structure-occurrence-v1#([A-Za-z][A-Za-z0-9_.-]{0,99})$/.exec(input.slot)?.[1];
    if (!path || input.context === 'global' || !IRI.test(input.context)
      || !IRI.test(input.occurrence) || path.split('.').length > 6) {
      throw new FieldWithdrawalInvalid('native child slot has no verified adapter');
    }
    const header = await readCompositionHeader(env, input.context);
    if (!header || header.work !== input.target || requireCurrent && header.head !== input.expectedHead) {
      throw new FieldWithdrawalConflict('native child owner or head changed');
    }
    const page = await readCompositionPage(env, { structure: input.context,
      revision: input.expectedHead, occurrence: input.occurrence, limit: 1,
      canReadTarget: async () => true });
    const record = page.occurrences[0];
    const native = record && valueAtPointer(record, `/${path.replaceAll('.', '/')}`);
    if (!record || record.state !== 'active' || record.occurrence !== input.occurrence
      || native === undefined || hash(JSON.stringify(native)) !== valueDigest) {
      throw new FieldWithdrawalConflict('source value differs from exact native child revision');
    }
    return;
  }
  const adapter = nativeSlotValue[input.slot];
  if (!adapter) throw new FieldWithdrawalInvalid('native field slot has no verified adapter');
  const revision = await readExactWorkRevision(env, input.expectedHead, async owner => owner === input.target);
  const value = adapter(revision);
  if (value === undefined || hash(JSON.stringify(value)) !== valueDigest) {
    throw new FieldWithdrawalConflict('source field differs from exact native revision');
  }
}

interface ExistingStep { id: string; support_id: string; request_digest: string; }
export class SourceFieldAttachmentStore {
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment,
    private readonly access: Pick<AccessAdmissionRegistry, 'withWorkEditAuthority'>) {}

  /** Locate a settled attachment after a lost import response, before retrying at a moved head. */
  async supportByKey(principalId: string, key: string): Promise<string | null> {
    if (!UUID.test(principalId) || !KEY.test(key)) {
      throw new FieldWithdrawalInvalid('invalid field support attachment identity');
    }
    const row = (await this.pool.query<{ support_id: string }>(`SELECT support_id
      FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
    [principalId, key])).rows[0];
    return row ? iri(row.support_id) : null;
  }

  /** One retained observation, one exact native revision, one Access lock envelope, one Source transaction. */
  async attach(principal: VerifiedPrincipal, principalId: string, key: string,
    input: AttachFieldSupportInput): Promise<{ support: string; replayed: boolean }> {
    const record = id(input.sourceRecord), conversion = id(input.conversion);
    if (input.profile !== 'source-field-support-attachment-v1' || !UUID.test(principalId)
      || !KEY.test(key) || !record || !conversion || !IRI.test(input.target)
      || !IRI.test(input.expectedHead) || !IRI.test(input.actingSubject)
      || (input.occurrence === null
        ? input.context !== 'global' || input.sourceOccurrence !== null || !nativeSlotValue[input.slot]
        : !IRI.test(input.occurrence) || !IRI.test(input.context)
          || !/^urn:rezics:source-occurrence:[0-9a-f]{64}$/.test(input.sourceOccurrence ?? '')
          || !/^structure-occurrence-v1#[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(input.slot))
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.grain)
      || !/^[A-Za-z0-9@$_][A-Za-z0-9@$_.:/#-]{0,199}$/.test(input.sourceField)) {
      throw new FieldWithdrawalInvalid('invalid field support attachment');
    }
    const evidence = (await this.pool.query<EvidenceRow>(fieldAttachmentEvidenceSql,
      [conversion, principalId, record, input.grain, input.sourceField])).rows[0];
    const checked = checkedFieldEvidence(evidence, input);
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    if (input.occurrence === null) {
      const head = await this.env.fuseki.query(`SELECT ?head WHERE { GRAPH <${GRAPHS.current}> {
        <${input.target}> <${RV}head> ?head } } LIMIT 2`);
      const heads = head.results?.bindings ?? [];
      if (heads.length !== 1 || heads[0]?.head?.value !== input.expectedHead) {
        throw new FieldWithdrawalConflict('Work head changed before source attachment');
      }
    }
    await checkedFieldNativeValue(this.env, input, checked.digest, true);
    const requestDigest = hash(JSON.stringify([principalId, input, checked.digest, checked.mapping]));
    const client = await this.pool.connect();
    try {
      return await this.access.withWorkEditAuthority(principal, input.actingSubject, input.target,
        async (proof: WorkEditAuthorityProof) => {
          if (proof.principalId !== principalId) throw new FieldWithdrawalConflict('source principal changed');
          try {
            await client.query('BEGIN');
            await client.query("SET LOCAL transaction_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '2s'");
            const prior = (await client.query<ExistingStep>(`SELECT id, support_id, request_digest
              FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
            [principalId, key])).rows[0];
            if (prior) {
              if (prior.request_digest !== requestDigest) throw new FieldWithdrawalConflict('attachment key changed');
              await client.query('COMMIT');
              return { support: iri(prior.support_id), replayed: true };
            }
            const supportId = Bun.randomUUIDv7(), stepId = Bun.randomUUIDv7();
            await client.query(`INSERT INTO source.field_support
              (id, principal_id, target, slot, occurrence, context, record_id)
              VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [supportId, principalId, input.target, input.slot, input.occurrence, input.context, record]);
            const support = (await client.query<{ id: string }>(`SELECT id FROM source.field_support
              WHERE principal_id = $1 AND target = $2 AND slot = $3
                AND occurrence IS NOT DISTINCT FROM $4 AND context = $5 AND record_id = $6 FOR SHARE`,
            [principalId, input.target, input.slot, input.occurrence, input.context, record])).rows[0];
            if (!support) throw new FieldWithdrawalUnavailable('field support row is unavailable');
            const state = (await client.query<{ step_count: number; pending_step_id: string | null }>(
              'SELECT step_count, pending_step_id FROM source.field_support_head WHERE support_id = $1 FOR UPDATE',
              [support.id])).rows[0];
            const raced = (await client.query<ExistingStep>(`SELECT id, support_id, request_digest
              FROM source.field_support_step WHERE principal_id = $1 AND idempotency_key = $2`,
            [principalId, key])).rows[0];
            if (raced) {
              if (raced.request_digest !== requestDigest || raced.support_id !== support.id) {
                throw new FieldWithdrawalConflict('attachment key changed');
              }
              await client.query('COMMIT');
              return { support: iri(raced.support_id), replayed: true };
            }
            if (!state || state.step_count !== 0 || state.pending_step_id) {
              throw new FieldWithdrawalConflict('field support already has a step');
            }
            await client.query(`INSERT INTO source.field_support_step
              (id, support_id, ordinal, principal_id, action, conversion_id, mapping_revision,
               grain, source_field, source_occurrence, value_digest, expected_head,
               control_intent, acting_subject, authority_proof, native_idempotency_key,
               idempotency_key, request_digest)
              VALUES ($1,$2,1,$3,'attach',$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12,NULL,$13,$14)`,
            [stepId, support.id, principalId, conversion, checked.mapping, input.grain,
              input.sourceField, input.sourceOccurrence, checked.digest, input.expectedHead, input.actingSubject,
              JSON.stringify(proof), key, requestDigest]);
            await client.query(`INSERT INTO source.field_support_outcome
              (step_id, outcome, native_revision, graph_receipt, admission_id, data_epoch,
               sequence, head_guarantee, receipt)
              VALUES ($1,'attached',$2,NULL,NULL,NULL,NULL,'verified-before-commit',$3)`,
            [stepId, input.expectedHead, JSON.stringify({ profile: 'source-field-attachment-certificate-v1',
              sourcePointer: input.sourcePointer, valueDigest: checked.digest })]);
            await client.query('COMMIT');
            return { support: iri(support.id), replayed: false };
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            if (['23505', '23514', '55P03', '57014'].includes((error as { code?: string }).code ?? '')) {
              throw new FieldWithdrawalConflict('field support changed during attachment');
            }
            throw error;
          }
        });
    } finally { client.release(); }
  }
}
