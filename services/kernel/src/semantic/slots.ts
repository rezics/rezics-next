import type { CommandTransaction } from '../command/command.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { writeFacts } from './write-facts.ts';
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
export async function latestAdoption(
  tx: CommandTransaction,
  subject: string,
  property: string,
  context: string,
): Promise<Adoption | null> {
  const result = await tx.query<Adoption>(
    `SELECT mode, head, selection, revision FROM semantic.adoption
     WHERE route = $1 AND subject_id = $2 AND slot_id = $3 AND context_id = $4
     ORDER BY head DESC LIMIT 1`,
    [routeOf(subject), subject, slotId(subject, property), context],
  );
  return result.rows[0] ?? null;
}

export async function currentAcceptance(
  tx: CommandTransaction,
  subject: string,
  candidate: string,
  context: string,
): Promise<{ head: number; verdict: 'accept' | 'reject' | 'abstain'; revision: number } | null> {
  const result = await tx.query<{ head: number; verdict: 'accept' | 'reject' | 'abstain'; revision: number }>(
    `SELECT head, verdict, revision FROM semantic.acceptance_current
     WHERE route = $1 AND subject_id = $2 AND context_id = $3 AND candidate_id = $4`,
    [routeOf(subject), subject, context, candidate],
  );
  return result.rows[0] ?? null;
}

export async function resolveSlot(tx: CommandTransaction, subject: string, property: string, context = GLOBAL_CONTEXT) {
  const route = routeOf(subject)!;
  const slot = slotId(subject, property);
  const args = [route, subject, slot];
  const last = await tx.query(
    `SELECT operation FROM semantic.fact WHERE route = $1 AND subject_id = $2 AND slot_id = $3
     ORDER BY log_seq DESC LIMIT 1`,
    args,
  );
  if (last.rows[0]?.operation === 'expand') {
    const adoption = await latestAdoption(tx, subject, property, context);
    return { expanded: true, compact: [] as Candidate[], adoption };
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
  const adoption: Adoption | null =
    context === GLOBAL_CONTEXT && compact.length
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

async function selectionFacts(
  tx: CommandTransaction,
  subject: string,
  property: string,
  selection: Adoption['selection'],
): Promise<FactRow[]> {
  if (!selection.length) return [];
  const result = await tx.query<Candidate & { adopted_rank: Statement['rank'] }>(
    `SELECT c.*, selected.entry->>'rank' AS adopted_rank
     FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS selected(entry, ordinal)
     JOIN LATERAL (SELECT * FROM semantic.candidate WHERE route = $1 AND subject_id = $2
       AND candidate_id = (selected.entry->>'candidate')::uuid LIMIT 1) c ON true
     ORDER BY selected.ordinal`,
    [routeOf(subject), subject, JSON.stringify(selection)],
  );
  return result.rows.map((row) => candidateFact(property, row, row.adopted_rank));
}

async function globalSlotView(tx: CommandTransaction, subject: string, property: string): Promise<FactRow[]> {
  const state = await resolveSlot(tx, subject, property, GLOBAL_CONTEXT);
  if (!state.expanded) return state.compact.map((candidate) => candidateFact(property, candidate));

  const selection = state.adoption?.mode === 'replace' ? state.adoption.selection : [];
  const selected = await selectionFacts(tx, subject, property, selection);
  const rejectedLimit = Math.max(0, 32 - selected.length);
  if (!rejectedLimit) return selected;
  const result = await tx.query<Candidate & { decision_revision: number }>(
    `SELECT * FROM (
       SELECT c.*, a.revision AS decision_revision
       FROM semantic.acceptance_current a
       JOIN LATERAL (
         SELECT * FROM semantic.candidate
         WHERE route = a.route AND subject_id = a.subject_id AND candidate_id = a.candidate_id
         LIMIT 1
       ) c ON true
       WHERE a.route = $1 AND a.subject_id = $2 AND a.context_id = $3 AND a.slot_id = $4
         AND a.verdict = 'reject'
       ORDER BY a.revision DESC, a.candidate_id
       LIMIT $6
     ) recent
     WHERE NOT (candidate_id = ANY($5::uuid[]))
     ORDER BY revision, view_order, candidate_id`,
    [
      routeOf(subject),
      subject,
      GLOBAL_CONTEXT,
      slotId(subject, property),
      selection.map((row) => row.candidate),
      rejectedLimit,
    ],
  );
  return [...selected, ...result.rows.map((row) => candidateFact(property, row, 'deprecated'))];
}

async function omitHidden(tx: CommandTransaction, subject: string, facts: FactRow[]): Promise<FactRow[]> {
  const ids = facts.flatMap((fact) =>
    fact.kind === 'statement' && fact.statement_id !== null ? [fact.statement_id] : [],
  );
  if (ids.length === 0) return facts;
  const hidden = await tx.query<{ candidate_id: string }>(
    `SELECT probed.candidate_id::text AS candidate_id
     FROM unnest($3::uuid[]) AS wanted(candidate_id)
     JOIN LATERAL (
       SELECT candidate_id FROM semantic.hidden_candidate
       WHERE route = $1 AND subject_id = $2 AND candidate_id = wanted.candidate_id
       OFFSET 0
       LIMIT 1
     ) probed ON true`,
    [routeOf(subject), subject, ids],
  );
  if (hidden.rows.length === 0) return facts;
  const gone = new Set(hidden.rows.map((row) => row.candidate_id));
  return facts.filter((fact) => fact.statement_id === null || !gone.has(fact.statement_id));
}

async function readSlotView(
  tx: CommandTransaction,
  subject: string,
  property: string,
  context = GLOBAL_CONTEXT,
  defaults: Readonly<Record<string, 'inherit' | 'suppress'>> = {},
): Promise<{ facts: FactRow[]; resolution?: 'unresolved' | 'suppressed' }> {
  if (context === GLOBAL_CONTEXT) return { facts: await globalSlotView(tx, subject, property) };

  const state = await resolveSlot(tx, subject, property, context);
  if (!state.expanded) {
    if (defaults[property] === 'suppress') return { facts: [], resolution: 'suppressed' };
    return { facts: state.compact.map((candidate) => candidateFact(property, candidate)) };
  }
  if (state.adoption?.mode === 'suppress' || (!state.adoption && defaults[property] === 'suppress'))
    return { facts: [], resolution: 'suppressed' };
  if (state.adoption?.mode === 'replace')
    return { facts: await selectionFacts(tx, subject, property, state.adoption.selection) };

  const global = await globalSlotView(tx, subject, property);
  if (!global.length) return { facts: global };
  const inherited: FactRow[] = [];
  for (const fact of global) {
    const decision = await currentAcceptance(tx, subject, fact.statement_id!, context);
    if (decision?.verdict !== 'reject') inherited.push(fact);
  }
  return inherited.length ? { facts: inherited } : { facts: inherited, resolution: 'unresolved' };
}

export async function slotView(
  tx: CommandTransaction,
  subject: string,
  property: string,
  context = GLOBAL_CONTEXT,
  defaults: Readonly<Record<string, 'inherit' | 'suppress'>> = {},
): Promise<{ facts: FactRow[]; resolution?: 'unresolved' | 'suppressed' }> {
  const view = await readSlotView(tx, subject, property, context, defaults);
  return { ...view, facts: await omitHidden(tx, subject, view.facts) };
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
  slot: string,
): Promise<number> {
  const head = (expectedHead ?? 0) + 1;
  const result = await tx.query(
    `INSERT INTO semantic.acceptance (route, subject_id, context_id, candidate_id, head, verdict, revision)
     SELECT $1, $2, $3, $4, $5, $6, $7
     WHERE COALESCE((SELECT head FROM semantic.acceptance
       WHERE route = $1 AND subject_id = $2 AND context_id = $3 AND candidate_id = $4
       ORDER BY head DESC LIMIT 1), 0) = $5 - 1
     ON CONFLICT DO NOTHING RETURNING head`,
    [routeOf(subject), subject, context, candidate, head, verdict, revision],
  );
  if (!result.rowCount) throw new StaleEditorialHeadError();
  await tx.query(
    `INSERT INTO semantic.acceptance_current
     (route, subject_id, context_id, candidate_id, slot_id, head, verdict, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (route, subject_id, context_id, candidate_id)
     DO UPDATE SET slot_id = EXCLUDED.slot_id, head = EXCLUDED.head,
                   verdict = EXCLUDED.verdict, revision = EXCLUDED.revision`,
    [routeOf(subject), subject, context, candidate, slot, head, verdict, revision],
  );
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
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     WHERE COALESCE((SELECT head FROM semantic.adoption
       WHERE route = $1 AND subject_id = $2 AND slot_id = $3 AND context_id = $4
       ORDER BY head DESC LIMIT 1), 0) = $5 - 1
     ON CONFLICT DO NOTHING RETURNING head`,
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
    await insertAcceptance(
      tx,
      subject,
      row.candidate_id,
      GLOBAL_CONTEXT,
      null,
      'accept',
      row.revision,
      slotId(subject, property),
    );
  }
  if (state.adoption) {
    const { head, mode, selection, revision } = state.adoption;
    // Materialize the virtual compact head, which can already represent several transactions.
    await tx.query(
      `INSERT INTO semantic.adoption (route, subject_id, slot_id, context_id, head, mode, selection, revision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        routeOf(subject),
        subject,
        slotId(subject, property),
        GLOBAL_CONTEXT,
        head,
        mode,
        JSON.stringify(selection),
        revision,
      ],
    );
  }
  const route = routeOf(subject);
  if (route === null) throw new RangeError('Subject id must be a canonical routed id');
  await writeFacts(tx, {
    route,
    subject_id: subject,
    transaction_id: transactionId,
    facts: [
      {
        slot_id: slotId(subject, property),
        log_seq: 33,
        operation: 'expand',
        kind: 'statement',
        language: null,
        property,
        statement_id: null,
        body: {},
        release: null,
      },
    ],
  });
}
