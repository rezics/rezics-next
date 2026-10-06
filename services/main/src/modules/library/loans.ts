import { randomUUID } from 'node:crypto';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';
import { readId } from '../work/read-contract.ts';
import { libraryParty, libraryTime, libraryTimestamp, validateLibraryParty, libraryRecordWrite,
  libraryRecordPage, InvalidLibraryRecord, StaleLibraryRecord, LibraryRecordMissing, LibraryRecordConflict,
  type CopyState, type LibraryRecordCommand, type LibraryParty } from './copies.ts';

export const loanDirection = t.Union([t.Literal('lent'), t.Literal('borrowed')]);
export const loanStatus = t.Union([t.Literal('open'), t.Literal('overdue'), t.Literal('returned')]);
export const loanState = t.Object({ id: readId, copy: readId, direction: loanDirection,
  counterparty: libraryParty, startedAt: libraryTime, dueAt: libraryTime,
  returnedAt: t.Nullable(libraryTime), version: t.Integer({ minimum: 1 }), changedAt: libraryTime },
{ additionalProperties: false });
export type LoanState = Static<typeof loanState>;
export type LoanView = LoanState & { state: Static<typeof loanStatus> };
export type LoanCommand = LibraryRecordCommand & ({ operation: 'open'; copy: string;
  direction: Static<typeof loanDirection>; counterparty: LibraryParty; startedAt: string; dueAt: string }
  | { operation: 'extend'; id: string; dueAt: string }
  | { operation: 'return'; id: string });
export const LIBRARY_LOAN_COST = { page: 20, pageRows: 21, pageStatements: 5,
  ordering: 'indexed due_at,id keyset O(log N + P)', writes: 'one loan and copy point read; O(log N)' } as const;
const view = (saved: LoanState, now: Date): LoanView => ({ ...saved,
  state: saved.returnedAt ? 'returned' : Date.parse(saved.dueAt) < now.getTime() ? 'overdue' : 'open' });

export class LibraryLoanStore {
  constructor(private readonly pool: Pool) {}
  async page(agent: string, options: { limit?: number; cursor?: string; state?: 'active' | 'returned' | 'overdue' }) {
    if (options.state !== undefined && !['active', 'returned', 'overdue'].includes(options.state)) {
      throw new InvalidLibraryRecord('Invalid loan filter');
    }
    return libraryRecordPage(this.pool, agent, ['library-loans-v1', agent, options.state ?? null], options,
      async (client, after, limit) => {
        let seek: [string, string] | null = null;
        if (after) {
          let parsed: unknown;
          try { parsed = JSON.parse(after); } catch { throw new InvalidLibraryRecord('Invalid loan cursor'); }
          if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string'
            || !Value.Check(readId, parsed[1])) throw new InvalidLibraryRecord('Invalid loan cursor');
          seek = [libraryTimestamp(parsed[0]), parsed[1]];
        }
        const filter = options.state === 'returned' ? 'AND returned_at IS NOT NULL'
          : options.state === 'active' ? 'AND returned_at IS NULL'
          : options.state === 'overdue' ? 'AND returned_at IS NULL AND due_at<statement_timestamp()' : '';
        const rows = await client.query<{ id: string; state: LoanState; now: Date }>(`
          SELECT id,state,statement_timestamp() AS now FROM reader.library_loan WHERE agent=$1 ${filter}
          ${seek ? 'AND (due_at,id)>($3::timestamptz,$4)' : ''}
          ORDER BY due_at,id LIMIT $2`, [agent, limit, ...(seek ?? [])]);
        return rows.rows.map(row => ({ key: JSON.stringify([row.state.dueAt, row.id]), value: view(row.state, row.now) }));
      });
  }
  async write(input: LoanCommand, authorize?: () => Promise<void>,
    checkParty?: (party: LibraryParty) => Promise<void>): Promise<LoanView & { replayed: boolean }> {
    const open = input.operation === 'open';
    if (open) {
      if (input.expectedVersion !== 0 || !Value.Check(readId, input.copy)
        || !Value.Check(loanDirection, input.direction)) throw new InvalidLibraryRecord('Invalid new loan');
      validateLibraryParty(input.counterparty);
      libraryTimestamp(input.startedAt); libraryTimestamp(input.dueAt);
    } else if (!Value.Check(readId, input.id)) throw new InvalidLibraryRecord('Invalid loan');
    if (input.operation === 'extend') libraryTimestamp(input.dueAt);
    const intent = open ? ['loan-open', input.copy, input.direction, input.counterparty.kind === 'name'
      ? ['name', input.counterparty.name] : ['person', input.counterparty.person], input.startedAt, input.dueAt, input.expectedVersion]
      : [input.operation, input.id, input.operation === 'extend' ? input.dueAt : null, input.expectedVersion];
    return libraryRecordWrite(this.pool, input, intent, open ? input.copy : null, async client => {
      const current = open ? null : (await client.query<{ state: LoanState }>(`
        SELECT state FROM reader.library_loan WHERE agent=$1 AND id=$2 FOR UPDATE`, [input.agent, input.id])).rows[0]?.state;
      if (!open && !current) throw new LibraryRecordMissing('Loan unavailable');
      if ((current?.version ?? 0) !== input.expectedVersion) throw new StaleLibraryRecord('Loan changed');
      const copy = open ? input.copy : current!.copy;
      if (!open) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [JSON.stringify(['library-copy', input.agent, copy])]);
      const ownedCopy = (await client.query<{ state: CopyState }>(`
        SELECT state FROM reader.library_copy WHERE agent=$1 AND id=$2 FOR UPDATE`, [input.agent, copy])).rows[0]?.state;
      if (!ownedCopy || ownedCopy.removed) throw new LibraryRecordMissing('Copy unavailable');
      const now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      let saved: LoanState;
      if (open) {
        await checkParty?.(input.counterparty);
        if ((await client.query(`SELECT 1 FROM reader.library_loan WHERE agent=$1 AND copy=$2 AND returned_at IS NULL LIMIT 1`,
          [input.agent, copy])).rowCount) throw new LibraryRecordConflict('Copy already has an active loan');
        saved = { id: `https://rezics.com/id/${randomUUID()}`, copy, direction: input.direction, counterparty: input.counterparty,
          startedAt: libraryTimestamp(input.startedAt), dueAt: libraryTimestamp(input.dueAt), returnedAt: null,
          version: 1, changedAt: now.toISOString() };
        if (saved.startedAt > now.toISOString() || saved.dueAt < saved.startedAt) {
          throw new InvalidLibraryRecord('Loan start must not be future and due time must follow start');
        }
      } else {
        if (current!.returnedAt) throw new LibraryRecordConflict('Loan has already been returned');
        saved = { ...current!, version: input.expectedVersion + 1, changedAt: now.toISOString() };
        if (input.operation === 'extend') {
          const dueAt = libraryTimestamp(input.dueAt);
          if (dueAt <= saved.dueAt) throw new InvalidLibraryRecord('Extension must move due time forward');
          saved.dueAt = dueAt;
        } else saved.returnedAt = now.toISOString();
      }
      await client.query(`INSERT INTO reader.library_loan(agent,id,copy,state,due_at,returned_at,version)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(agent,id) DO UPDATE
        SET state=EXCLUDED.state,due_at=EXCLUDED.due_at,returned_at=EXCLUDED.returned_at,version=EXCLUDED.version`,
      [input.agent, saved.id, copy, JSON.stringify(saved), saved.dueAt, saved.returnedAt, saved.version]);
      return view(saved, now);
    }, authorize);
  }
}
