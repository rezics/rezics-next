import type { CommandTransaction } from '../command/command.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT, StaleEditorialHeadError } from './definitions.ts';
import { SLOT_NS, type FactRow, type Statement } from './item.ts';

export type Candidate = {
  candidate_id: string;
  statement: unknown;
  rank: 'normal' | 'preferred';
  release: string;
  revision: number;
  view_order: number;
};
export type Adoption = {
  mode: 'inherit' | 'replace' | 'suppress';
  head: number;
  selection: { candidate: string; rank: 'normal' | 'preferred' }[];
  revision: number;
};
export function slotId(subject: string, property: string): string {
  return derivedId(SLOT_NS, `${subject}\nstatement\n${property}`, routeOf(subject)!);
}

/** A single bounded resolver for virtual compact state and persisted editorial state. */
export async function resolveSlot(tx: CommandTransaction, subject: string, property: string) {
  const route = routeOf(subject)!;
  const slot = slotId(subject, property);
  const args = [route, subject, slot];
  const last = await tx.query(
    `SELECT operation FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND slot_id = $3
     ORDER BY log_seq DESC LIMIT 1`,
    args,
  );
  if (last.rows[0]?.operation === 'expand') {
    const result = await tx.query<Adoption>(
      `SELECT mode, head, selection, revision FROM semantic.adoption
       WHERE route = $1 AND subject_id = $2 AND slot_id = $3 AND context_id = $4
       ORDER BY head DESC LIMIT 1`,
      [...args, GLOBAL_CONTEXT],
    );
    return { expanded: true, compact: [] as Candidate[], adoption: result.rows[0] ?? null };
  }
  const result = await tx.query<Candidate & { operation: string; tx: string }>(
    `SELECT f.statement_id::text AS candidate_id, f.body AS statement, f.body->>'rank' AS rank,
            r.release, r.revision, f.log_seq AS view_order, f.operation, f.recorded_transaction_id::text AS tx
     FROM semantic.fact f JOIN LATERAL (
       SELECT revision, release FROM semantic.revision
       WHERE route = f.route AND subject_id = f.subject_id AND recorded_transaction_id = f.recorded_transaction_id
       LIMIT 1
     ) r ON true
     WHERE f.route = $1 AND f.subject_id = $2 AND f.slot_id = $3 ORDER BY f.log_seq`,
    args,
  );
  const live = new Map<string, Candidate>();
  for (const row of result.rows) {
    live.delete(row.candidate_id);
    if (row.operation === 'assert') live.set(row.candidate_id, row);
  }
  const compact = [...live.values()];
  const adoption: Adoption | null = compact.length
    ? {
        mode: 'replace',
        head: new Set(result.rows.map((row) => row.tx)).size,
        selection: compact.map((row) => ({ candidate: row.candidate_id, rank: row.rank })),
        revision: Math.max(...compact.map((row) => row.revision)),
      }
    : null;
  return { expanded: false, compact, adoption };
}

export function candidateFact(
  property: string,
  candidate: Candidate,
  rank: Statement['rank'] = candidate.rank,
): FactRow {
  return {
    kind: 'statement',
    language: null,
    property,
    statement_id: candidate.candidate_id,
    operation: 'assert',
    body: { ...(candidate.statement as object), rank },
    fact_release: candidate.release,
    fact_revision: candidate.revision,
  };
}

export async function slotView(tx: CommandTransaction, subject: string, property: string): Promise<FactRow[]> {
  const state = await resolveSlot(tx, subject, property);
  if (!state.expanded) return state.compact.map((candidate) => candidateFact(property, candidate));
  if (state.adoption?.mode !== 'replace') return [];
  const result = await tx.query<Candidate & { adopted_rank: Statement['rank'] }>(
    `SELECT c.*, selected.entry->>'rank' AS adopted_rank
     FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS selected(entry, ordinal)
     JOIN LATERAL (SELECT * FROM semantic.candidate WHERE route = $1 AND subject_id = $2
       AND candidate_id = (selected.entry->>'candidate')::uuid LIMIT 1) c ON true
     ORDER BY selected.ordinal`,
    [routeOf(subject), subject, JSON.stringify(state.adoption.selection)],
  );
  return result.rows.map((row) => candidateFact(property, row, row.adopted_rank));
}

/** Insert-CAS: collision with an already written head never overwrites history. */
export async function insertAcceptance(
  tx: CommandTransaction,
  subject: string,
  candidate: string,
  context: string,
  expectedHead: number | null,
  verdict: 'accept' | 'reject' | 'abstain',
  revision: number,
): Promise<number> {
  const head = (expectedHead ?? 0) + 1;
  const result = await tx.query(
    `INSERT INTO semantic.acceptance (route, subject_id, context_id, candidate_id, head, verdict, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING head`,
    [routeOf(subject), subject, context, candidate, head, verdict, revision],
  );
  if (!result.rowCount) throw new StaleEditorialHeadError();
  return head;
}

export async function insertAdoption(
  tx: CommandTransaction,
  subject: string,
  property: string,
  context: string,
  expectedHead: number | null,
  mode: Adoption['mode'],
  selection: Adoption['selection'],
  revision: number,
): Promise<number> {
  const head = (expectedHead ?? 0) + 1;
  const result = await tx.query(
    `INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING RETURNING head`,
    [routeOf(subject), subject, slotId(subject, property), context, head, mode, JSON.stringify(selection), revision],
  );
  if (!result.rowCount) throw new StaleEditorialHeadError();
  return head;
}

export async function expandSlot(
  tx: CommandTransaction,
  subject: string,
  property: string,
  transactionId: string,
): Promise<void> {
  const state = await resolveSlot(tx, subject, property);
  if (state.expanded) return;
  for (const row of state.compact) {
    await tx.query(
      `INSERT INTO semantic.candidate
       (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin, view_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'compact', $10)`,
      [
        routeOf(subject),
        subject,
        row.candidate_id,
        slotId(subject, property),
        property,
        row.rank,
        JSON.stringify(row.statement),
        row.release,
        row.revision,
        row.view_order,
      ],
    );
    await insertAcceptance(tx, subject, row.candidate_id, GLOBAL_CONTEXT, null, 'accept', row.revision);
  }
  if (state.adoption) {
    const { head, mode, selection, revision } = state.adoption;
    await insertAdoption(tx, subject, property, GLOBAL_CONTEXT, head - 1 || null, mode, selection, revision);
  }
  await tx.query(
    `INSERT INTO semantic.fact
     (route, subject_id, slot_id, log_seq, operation, kind, property, body, recorded_transaction_id)
     VALUES ($1, $2, $3, 33, 'expand', 'statement', $4, '{}', $5)`,
    [routeOf(subject), subject, slotId(subject, property), property, transactionId],
  );
}
