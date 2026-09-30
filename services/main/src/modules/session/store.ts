import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ReaderLibraryStatusStore } from '../library/status.ts';
import { decodeReadCursor, encodeReadCursor } from '../work/read-session.ts';
import { readId } from '../work/read-contract.ts';
import { InvalidSession, SESSION_COST, SessionConflict, SessionMissing, StaleSession,
  sessionState, type SessionChanges, type SessionSelection, type SessionState } from './contract.ts';
import { applySessionChanges } from './state.ts';

const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
export interface SessionOwner { principal: VerifiedPrincipal; agent: string }
export interface SessionCommand extends SessionOwner {
  id?: string; target?: string; changes: SessionChanges;
  expectedVersion: number; idempotencyKey: string;
}
type Row = { state: SessionState; attempt_order: string };
type Resolve = (current: SessionState | null) => Promise<SessionSelection[]>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function owner(input: SessionOwner) {
  if (!input.principal.issuer || !input.principal.subject || !Value.Check(readId, input.agent)) {
    throw new InvalidSession('Invalid session owner');
  }
  return [input.principal.issuer, input.principal.subject, input.agent];
}
function checked(row: Row): SessionState {
  if (!Value.Check(sessionState, row.state)) throw new Error('Consumption session is corrupt');
  return row.state;
}

/** All writes lock one command and one owner/Work. The Library owner command
 * runs in this same Content transaction. No worker, cross-owner delivery queue
 * or private graph projection is required. Advisory locks follow PostgreSQL's
 * transaction-scoped behavior: https://www.postgresql.org/docs/current/explicit-locking.html */
export class ConsumptionSessionStore {
  constructor(private readonly pool: Pool, private readonly library: ReaderLibraryStatusStore) {}

  async page(input: SessionOwner, options: { target?: string; limit?: number; cursor?: string }) {
    const identity = owner(input);
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_COST.page
      || options.target !== undefined && !Value.Check(readId, options.target)) throw new InvalidSession('Invalid session page');
    const control = await this.pool.query<{ data_epoch: string }>(
      'SELECT data_epoch FROM content.owner_control WHERE singleton');
    if (!control.rows[0]) throw new Error('Content owner position unavailable');
    const position = { dataEpoch: control.rows[0].data_epoch, sequence: '0' };
    const binding = ['consumption-sessions-v1', ...identity, options.target ?? null];
    const cursor = decodeReadCursor(options.cursor, binding, position);
    if (cursor && !/^[1-9][0-9]*$/.test(cursor.after)) throw new InvalidSession('Invalid session cursor');
    // Creation order is immutable: edits cannot move an attempt between pages.
    // Separate query shapes keep both seek paths on their leading index keys.
    const rows = await this.pool.query<Row>(options.target
      ? `SELECT s.state, s.attempt_order::text FROM reader.consumption_session_target t
         JOIN reader.consumption_session s ON s.id = t.session
         WHERE t.principal_issuer = $1 AND t.principal_subject = $2 AND t.agent = $3
           AND s.principal_issuer = t.principal_issuer AND s.principal_subject = t.principal_subject AND s.agent = t.agent
           AND t.resource = $4 ${cursor ? 'AND t.attempt_order < $6::bigint' : ''}
         ORDER BY t.attempt_order DESC LIMIT $5`
      : `SELECT s.state, s.attempt_order::text FROM reader.consumption_session s
         WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3
           ${cursor ? 'AND s.attempt_order < $5::bigint' : ''}
         ORDER BY s.attempt_order DESC LIMIT $4`,
    options.target ? [...identity, options.target, limit + 1, ...(cursor ? [cursor.after] : [])]
      : [...identity, limit + 1, ...(cursor ? [cursor.after] : [])]);
    const page = rows.rows.slice(0, limit);
    return { items: page.map(checked), nextCursor: rows.rows.length > limit
      ? encodeReadCursor(binding, position, page.at(-1)!.attempt_order) : null };
  }

  async write(input: SessionCommand, resolve: Resolve, assertOwner: () => Promise<void>) {
    const identity = owner(input);
    const create = input.id === undefined;
    if (!KEY.test(input.idempotencyKey) || !Number.isSafeInteger(input.expectedVersion)
      || input.expectedVersion < 0 || input.expectedVersion >= Number.MAX_SAFE_INTEGER
      || create && (input.expectedVersion !== 0 || !Value.Check(readId, input.target))
      || !create && (!Value.Check(readId, input.id) || input.target !== undefined)
      || !create && !Object.values(input.changes).some(value => value !== undefined)) {
      throw new InvalidSession('Invalid session command');
    }
    // Explicit member order makes object-key ordering irrelevant. Keep markers
    // distinguish omitted dates from explicit unknown dates in receipt intent.
    const c = input.changes;
    const digest = hash([create ? 'create' : 'update', input.id ?? null, input.target ?? null, input.agent,
      input.expectedVersion, c.state ?? ['keep'], c.startedOn === undefined ? ['keep'] : c.startedOn,
      c.finishedOn === undefined ? ['keep'] : c.finishedOn,
      c.addSelections?.map(s => [s.target, s.language ?? null, s.format ?? null]) ?? [],
      c.position ? [c.position.target, c.position.unit, c.position.value] : null]);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['session-key', ...identity.slice(0, 2), input.idempotencyKey])]);
      const prior = await client.query<{ request_digest: string; result: SessionState }>(`
        SELECT request_digest, result FROM reader.consumption_session_command
        WHERE principal_issuer = $1 AND principal_subject = $2 AND idempotency_key = $3`,
      [...identity.slice(0, 2), input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== digest) throw new SessionConflict('Idempotency key has another session intent');
        await assertOwner();
        await client.query('COMMIT');
        return { ...prior.rows[0].result, replayed: true };
      }
      let current: SessionState | null = null;
      if (!create) {
        const found = await client.query<Row>(`SELECT state, attempt_order::text FROM reader.consumption_session
          WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND id = $4`, [...identity, input.id]);
        if (!found.rows[0]) throw new SessionMissing('Session is unavailable');
        current = checked(found.rows[0]);
      }
      const selections = await resolve(current);
      const target = current?.target ?? selections[0]?.target;
      if (!target?.work) throw new InvalidSession('Session needs an exact Trackable target');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['session-work', ...identity, target.work])]);
      if (!create) {
        const locked = await client.query<Row>(`SELECT state, attempt_order::text FROM reader.consumption_session
          WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND id = $4 FOR UPDATE`, [...identity, input.id]);
        current = checked(locked.rows[0]!);
        if (current.version !== input.expectedVersion) {
          await assertOwner();
          throw new StaleSession(current, { ...c, expectedVersion: input.expectedVersion });
        }
      }
      const now = new Date().toISOString();
      const base: SessionState = current ?? { id: `https://rezics.com/id/${randomUUID()}`, target,
        state: c.state ?? 'planned', startedOn: null, finishedOn: null, selections: [], locators: [],
        completedAt: null, version: 0, createdAt: now, changedAt: now };
      const result = applySessionChanges(base, c, selections, now);
      if (!Value.Check(sessionState, result)) throw new InvalidSession('Invalid consumption session state');
      const written = await client.query<Row>(create
        ? `INSERT INTO reader.consumption_session (id, principal_issuer, principal_subject, agent, work, state, version)
           VALUES ($4,$1,$2,$3,$5,$6,$7) RETURNING state, attempt_order::text`
        : `UPDATE reader.consumption_session SET state = $6, version = $7
           WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND id = $4 AND work = $5
           RETURNING state, attempt_order::text`, [...identity, result.id, target.work, JSON.stringify(result), result.version]);
      const order = written.rows[0]!.attempt_order;
      await client.query(`INSERT INTO reader.consumption_session_target
        (session, principal_issuer, principal_subject, agent, resource, attempt_order)
        SELECT $4, $1, $2, $3, resource, $5::bigint FROM unnest($6::text[]) AS resource
        ON CONFLICT (session, resource) DO NOTHING`, [...identity, result.id, order,
        result.selections.map(selection => selection.target.resource)]);
      const latest = await client.query<{ id: string }>(`SELECT id FROM reader.consumption_session
        WHERE principal_issuer = $1 AND principal_subject = $2 AND agent = $3 AND work = $4
        ORDER BY attempt_order DESC LIMIT 1`, [...identity, target.work]);
      if (latest.rows[0]?.id === result.id) await this.project(client, input, result);
      const operation = `session:${hash([...identity.slice(0, 2), input.idempotencyKey])}`;
      const control = await client.query<{ data_epoch: string; sequence: string }>(
        'UPDATE content.owner_control SET sequence = sequence + 1 WHERE singleton RETURNING data_epoch, sequence::text');
      if (!control.rows[0]) throw new Error('Content owner position unavailable');
      await client.query(`INSERT INTO content.receipt
        (operation_id, request_digest, action, outcome, data_epoch, sequence) VALUES ($1,$2,$3,'succeeded',$4,$5)`,
      [operation, digest, create ? 'session.create' : 'session.update', control.rows[0].data_epoch, control.rows[0].sequence]);
      await client.query(`INSERT INTO reader.consumption_session_command
        (principal_issuer, principal_subject, idempotency_key, request_digest, session, result, content_operation)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...identity.slice(0, 2), input.idempotencyKey, digest,
        result.id, JSON.stringify(result), operation]);
      await assertOwner();
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async project(client: PoolClient, input: SessionCommand, state: SessionState) {
    const work = state.target.work!;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [JSON.stringify(['library-status-work', input.agent, work])]);
    const [current] = await this.library.batch(input.agent, [work], client);
    const status = state.state === 'planned' ? 'want-to-read' : state.state === 'finished' ? 'read'
      : state.state === 'dnf' ? null : 'reading';
    await this.library.write({ agent: input.agent, work, status,
      sessionProjection: state.id,
      startedOn: state.startedOn?.length === 10 ? state.startedOn : null,
      finishedOn: state.finishedOn?.length === 10 ? state.finishedOn : null,
      expectedVersion: current!.version,
      idempotencyKey: `session.${hash([input.principal.issuer, input.principal.subject, input.idempotencyKey])}` }, client);
  }
}
