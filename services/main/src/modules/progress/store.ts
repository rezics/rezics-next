import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { advanceContentSequence, settledContentPosition } from '../content-sequence.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const REVISION = /^urn:rezics:content:revision:[0-9a-f-]{36}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;

export class InvalidStructureProgress extends Error {}
export class StaleStructureProgress extends Error {}
export class StructureProgressConflict extends Error {}

export interface StructureProgress {
  structure: string;
  occurrence: string;
  selectedRevision: string | null;
  completed: boolean;
  position: string | null;
  version: number;
  replayed?: boolean;
}

export interface ProgressWrite {
  principal: VerifiedPrincipal;
  structure: string;
  occurrence: string;
  selectedRevision?: string | null;
  completed: boolean;
  position: string | null;
  expectedVersion: number;
  idempotencyKey: string;
  /** Authorized parent Work resolved by the route, updated in this transaction. */
  library?: { agent: string; work: string };
}

function validIdentity(structure: string, occurrence: string, selectedRevision: string | null) {
  if (!ID.test(structure) || !ID.test(occurrence)
    || selectedRevision !== null && !REVISION.test(selectedRevision)) {
    throw new InvalidStructureProgress('progress identity is invalid');
  }
}

function state(input: { structure: string; occurrence: string; selectedRevision: string | null },
  row?: { completed: boolean; position: string | null; version: string | number }): StructureProgress {
  return { structure: input.structure, occurrence: input.occurrence,
    selectedRevision: input.selectedRevision, completed: row?.completed ?? false,
    position: row?.position ?? null, version: Number(row?.version ?? 0) };
}

/** Private Content-DB owner; no target bytes or publication state are copied here. */
export class StructureProgressStore {
  constructor(private readonly pool: Pool) {}

  async read(principal: VerifiedPrincipal, structure: string, occurrence: string,
    selectedRevision: string | null = null): Promise<StructureProgress> {
    validIdentity(structure, occurrence, selectedRevision);
    const result = await this.pool.query<{ completed: boolean; position: string | null; version: string }>(
      `SELECT completed, position, version::text AS version FROM structure.progress
       WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3
         AND occurrence = $4 AND selection_key = $5`,
      [principal.issuer, principal.subject, structure, occurrence, selectedRevision ?? '']);
    return state({ structure, occurrence, selectedRevision }, result.rows[0]);
  }

  private async projectLibrary(client: PoolClient, input: ProgressWrite) {
    if (!input.library) return;
    await client.query(`UPDATE reader.library_status SET last_read_at = greatest(last_read_at,
      (SELECT max(updated_at) FROM structure.progress WHERE principal_issuer = $3
        AND principal_subject = $4 AND structure = $5))
      WHERE agent = $1 AND work = $2`, [input.library.agent, input.library.work,
      input.principal.issuer, input.principal.subject, input.structure]);
  }

  async write(input: ProgressWrite): Promise<StructureProgress> {
    const selectedRevision = input.selectedRevision ?? null;
    validIdentity(input.structure, input.occurrence, selectedRevision);
    if (!KEY.test(input.idempotencyKey) || !Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 0 || typeof input.completed !== 'boolean'
      || input.position !== null && (typeof input.position !== 'string'
        || Buffer.byteLength(input.position) < 1 || Buffer.byteLength(input.position) > 500
        || /[\u0000-\u001f\u007f]/u.test(input.position))) {
      throw new InvalidStructureProgress('progress command is invalid');
    }
    if (input.library && (!ID.test(input.library.agent) || !ID.test(input.library.work))) {
      throw new InvalidStructureProgress('library identity is invalid');
    }
    const identity = { structure: input.structure, occurrence: input.occurrence, selectedRevision };
    const selectionKey = selectedRevision ?? '';
    const digest = createHash('sha256').update(JSON.stringify([input.structure, input.occurrence,
      selectionKey, input.completed, input.position, input.expectedVersion])).digest('hex');
    const client = await this.pool.connect();
    let saved: StructureProgress;
    let operation: string | null = null;
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      if (input.library) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['library-status-work', input.library.agent, input.library.work])]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['structure-progress', input.principal.issuer,
          input.principal.subject, input.idempotencyKey])]);
      const prior = await client.query<{ request_digest: string; structure: string; occurrence: string;
        selection_key: string; result_completed: boolean; result_position: string | null;
        result_version: string }>(
        `SELECT request_digest, structure, occurrence, selection_key, result_completed, result_position,
           result_version::text AS result_version FROM structure.progress_command
         WHERE principal_issuer = $1 AND principal_subject = $2 AND idempotency_key = $3`,
        [input.principal.issuer, input.principal.subject, input.idempotencyKey]);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.request_digest !== digest || row.structure !== input.structure
          || row.occurrence !== input.occurrence || row.selection_key !== selectionKey) {
          throw new StructureProgressConflict('progress idempotency key has another intent');
        }
        await this.projectLibrary(client, input);
        await client.query('COMMIT');
        return { ...state(identity, { completed: row.result_completed,
          position: row.result_position, version: row.result_version }), replayed: true };
      }
      // Serialize selections for one chapter so each reader contributes at most
      // one read and one finish, even with concurrent revision-specific writes.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['structure-progress-chapter', input.principal.issuer,
          input.principal.subject, input.structure, input.occurrence])]);
      const first = await client.query<{ read: boolean; finished: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM structure.progress_command
          WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3 AND occurrence = $4)
            AS read,
          NOT EXISTS (SELECT 1 FROM structure.progress_command
          WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3 AND occurrence = $4
            AND result_completed) AS finished`,
        [input.principal.issuer, input.principal.subject, input.structure, input.occurrence]);
      const current = await client.query<{ version: string }>(
        `SELECT version::text AS version FROM structure.progress
         WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3
           AND occurrence = $4 AND selection_key = $5 FOR UPDATE`,
        [input.principal.issuer, input.principal.subject, input.structure, input.occurrence, selectionKey]);
      const version = Number(current.rows[0]?.version ?? 0);
      if (version !== input.expectedVersion) throw new StaleStructureProgress('progress version changed');
      const next = version + 1;
      operation = `structure.progress:${createHash('sha256').update(JSON.stringify([
        input.principal.issuer, input.principal.subject, input.idempotencyKey])).digest('hex')}`;
      if (version === 0) {
        await client.query(`INSERT INTO structure.progress
          (principal_issuer, principal_subject, structure, occurrence, selection_key,
            completed, position, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.principal.issuer, input.principal.subject, input.structure, input.occurrence,
          selectionKey, input.completed, input.position, next]);
      } else {
        await client.query(`UPDATE structure.progress SET completed = $6, position = $7,
          version = $8, updated_at = clock_timestamp() WHERE principal_issuer = $1
          AND principal_subject = $2 AND structure = $3 AND occurrence = $4 AND selection_key = $5`,
        [input.principal.issuer, input.principal.subject, input.structure, input.occurrence,
          selectionKey, input.completed, input.position, next]);
      }
      await client.query(`INSERT INTO structure.progress_command
        (principal_issuer, principal_subject, idempotency_key, request_digest,
          structure, occurrence, selection_key, result_version, result_completed, result_position,
          content_operation, first_read, first_finish)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [input.principal.issuer, input.principal.subject, input.idempotencyKey, digest,
        input.structure, input.occurrence, selectionKey, next, input.completed, input.position,
        operation, first.rows[0]!.read, input.completed && first.rows[0]!.finished]);
      await advanceContentSequence(client, { operationId: operation, requestDigest: digest,
        action: 'structure.progress', outcome: 'succeeded', eventType: 'structure.progress.written',
        recipe: 'structure-progress-v1', payload: { structure: input.structure, occurrence: input.occurrence,
          read: first.rows[0]!.read, finished: input.completed && first.rows[0]!.finished } });
      await this.projectLibrary(client, input);
      await client.query('COMMIT');
      saved = { ...state(identity, { completed: input.completed,
        position: input.position, version: next }), replayed: false };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new StaleStructureProgress('progress changed concurrently');
      }
      throw error;
    } finally { client.release(); }
    // The save is acknowledged once its event is numbered, so ordered consumers
    // (rankings, relays) see it before the reader's next request.
    await settledContentPosition(this.pool, operation!);
    return saved;
  }
}
