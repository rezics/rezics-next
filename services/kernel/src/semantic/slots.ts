import type { CommandTransaction } from '../command/command.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { writeFacts } from './write-facts.ts';
import { GLOBAL_CONTEXT, StaleEditorialHeadError } from './definitions.ts';
import { SLOT_NS, type FactRow, type Statement } from './item.ts';
import insertAcceptanceCurrent from './slots-insert-acceptance-current.sql';
import insertAcceptanceHead from './slots-insert-acceptance.sql';
import insertAdoptionHead from './slots-insert-adoption.sql';
import insertCandidate from './slots-insert-candidate.sql';
import insertExpandedAdoption from './slots-insert-expanded-adoption.sql';
import readCurrentAcceptance from './slots-read-acceptance.sql';
import readLatestAdoption from './slots-read-adoption.sql';
import readCompactFacts from './slots-read-compact.sql';
import readHiddenCandidates from './slots-read-hidden.sql';
import readSlotOperation from './slots-read-operation.sql';
import readRejectedCandidates from './slots-read-rejected.sql';
import readSelectionFacts from './slots-read-selection.sql';

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
  const row = await readLatestAdoption.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    slot_id: slotId(subject, property),
    context_id: context,
  });
  return row ?? null;
}

export async function currentAcceptance(
  tx: CommandTransaction,
  subject: string,
  candidate: string,
  context: string,
): Promise<{ head: number; verdict: 'accept' | 'reject' | 'abstain'; revision: number } | null> {
  const row = await readCurrentAcceptance.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    context_id: context,
    candidate_id: candidate,
  });
  return row ?? null;
}

export async function resolveSlot(tx: CommandTransaction, subject: string, property: string, context = GLOBAL_CONTEXT) {
  const route = routeOf(subject)!;
  const slot = slotId(subject, property);
  const last = await readSlotOperation.run(tx, { route, subject_id: subject, slot_id: slot });
  if (last?.operation === 'expand') {
    const adoption = await latestAdoption(tx, subject, property, context);
    return { expanded: true, compact: [] as Candidate[], adoption };
  }
  const rows = await readCompactFacts.run(tx, { route, subject_id: subject, slot_id: slot });
  const live = new Map<string, Candidate>();
  for (const row of rows) {
    live.delete(row.candidate_id);
    if (row.operation === 'assert') live.set(row.candidate_id, row);
  }
  const compact = [...live.values()];
  const adoption: Adoption | null =
    context === GLOBAL_CONTEXT && compact.length
      ? {
          mode: 'replace',
          head: new Set(rows.map((row) => row.tx)).size,
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
  const rows = await readSelectionFacts.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    selection,
  });
  return rows.map((row) => candidateFact(property, row, row.adopted_rank));
}

async function globalSlotView(tx: CommandTransaction, subject: string, property: string): Promise<FactRow[]> {
  const state = await resolveSlot(tx, subject, property, GLOBAL_CONTEXT);
  if (!state.expanded) return state.compact.map((candidate) => candidateFact(property, candidate));

  const selection = state.adoption?.mode === 'replace' ? state.adoption.selection : [];
  const selected = await selectionFacts(tx, subject, property, selection);
  const rejectedLimit = Math.max(0, 32 - selected.length);
  if (!rejectedLimit) return selected;
  const rows = await readRejectedCandidates.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    context_id: GLOBAL_CONTEXT,
    slot_id: slotId(subject, property),
    rejected_limit: rejectedLimit,
    excluded: selection.map((row) => row.candidate),
  });
  return [...selected, ...rows.map((row) => candidateFact(property, row, 'deprecated'))];
}

async function omitHidden(tx: CommandTransaction, subject: string, facts: FactRow[]): Promise<FactRow[]> {
  const ids = facts.flatMap((fact) =>
    fact.kind === 'statement' && fact.statement_id !== null ? [fact.statement_id] : [],
  );
  if (ids.length === 0) return facts;
  const hidden = await readHiddenCandidates.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    candidate_ids: ids,
  });
  if (hidden.length === 0) return facts;
  const gone = new Set(hidden.map((row) => row.candidate_id));
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
  const route = routeOf(subject)!;
  const inserted = await insertAcceptanceHead.run(tx, {
    route,
    subject_id: subject,
    context_id: context,
    candidate_id: candidate,
    head,
    verdict,
    revision,
  });
  if (!inserted.length) throw new StaleEditorialHeadError();
  await insertAcceptanceCurrent.run(tx, {
    route,
    subject_id: subject,
    context_id: context,
    candidate_id: candidate,
    slot_id: slot,
    head,
    verdict,
    revision,
  });
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
  const inserted = await insertAdoptionHead.run(tx, {
    route: routeOf(subject)!,
    subject_id: subject,
    slot_id: slotId(subject, property),
    context_id: context,
    head,
    mode,
    selection,
    revision,
  });
  if (!inserted.length) throw new StaleEditorialHeadError();
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
    await insertCandidate.run(tx, {
      route: routeOf(subject)!,
      subject_id: subject,
      candidate_id: row.candidate_id,
      slot_id: slotId(subject, property),
      property,
      rank: row.rank,
      statement: row.statement,
      release: row.release,
      revision: row.revision,
      view_order: row.view_order,
    });
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
    await insertExpandedAdoption.run(tx, {
      route: routeOf(subject)!,
      subject_id: subject,
      slot_id: slotId(subject, property),
      context_id: GLOBAL_CONTEXT,
      head,
      mode,
      selection,
      revision,
    });
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
