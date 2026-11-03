import { candidateFailure, type CandidateFailure } from '../../subject/candidates';
import {
  validRelationSlot,
  type RelationDraft,
  type RelationProposal,
  type RelationProposalResult,
  type RelationSlot,
} from '../../subject/relation-candidates';
import { partCorrection, type PartRow, type PartStream } from './work-parts';

export const orderingLimit = 16;
export type OrderingReview = { status: 'closed' } | { status: 'current' | 'stale'; fingerprint: string };
export type OrderingResult = RelationProposalResult;
export type OrderingOutcome = 'proposed' | 'uncertain' | 'refused' | 'editable';
export type OrderingDraft = {
  key: string;
  holder: string;
  statementId: string;
  streamKey: string;
  cursor: string;
  property: string;
  direction: PartStream['direction'];
  summary: PartRow['summary'];
  related: PartRow['related'];
  original: RelationDraft;
  statement: RelationDraft;
  originalSlot?: RelationSlot | undefined;
  slot?: RelationSlot | undefined;
  currentPosition: string;
  proposedPosition: string;
  positionIsSlotKey: boolean;
  included: boolean;
  admitted: boolean;
  present?: boolean | undefined;
  disabledReason?: 'definition' | 'unavailable' | undefined;
  command?: RelationProposal | undefined;
  result?: OrderingResult | undefined;
};

export function orderingKey(row: Pick<PartRow, 'holder' | 'statementId'>): string {
  return `${row.holder}:${row.statementId}`;
}

export function currentPosition(statement: RelationDraft): string {
  const part = statement.qualifiers.find((snak) => snak.property.id === 'schema:position');
  return part?.value.type === 'value' && typeof part.value.content === 'string' ? part.value.content : '';
}

export function replacePosition(statement: RelationDraft, position: string): RelationDraft {
  const next = structuredClone(statement);
  const snak: RelationDraft['qualifiers'][number] = {
    property: { id: 'schema:position', data_type: 'string' },
    value: { type: 'value', content: position },
  };
  const index = next.qualifiers.findIndex((part) => part.property.id === 'schema:position');
  if (index >= 0) next.qualifiers[index] = { ...next.qualifiers[index]!, ...snak };
  else next.qualifiers.push(snak);
  return next;
}

function writerSlot(slot: RelationSlot | undefined): RelationSlot | undefined {
  if (!slot) return;
  if (validRelationSlot(slot)) return slot;
  const { key: _key, ...rest } = slot;
  return validRelationSlot(rest) ? rest : undefined;
}

export function proposedSlot(draft: Pick<OrderingDraft, 'originalSlot' | 'proposedPosition' | 'positionIsSlotKey'>) {
  if (!draft.positionIsSlotKey) return writerSlot(draft.originalSlot);
  const next = draft.originalSlot ? { ...draft.originalSlot, key: draft.proposedPosition } : undefined;
  return writerSlot(next);
}

export function stageOrderingRow(
  row: PartRow,
  stream: PartStream,
  cursor?: string,
): OrderingDraft | undefined {
  if (!stream.positionEditable) return;
  const correction = partCorrection(row, stream);
  if (!correction) return;
  const original = structuredClone(correction.statement);
  const position = currentPosition(original);
  const positionIsSlotKey = stream.slotKey === 'schema:position';
  return {
    key: orderingKey(row),
    holder: row.holder,
    statementId: row.statementId,
    streamKey: stream.key,
    cursor: cursor ?? '',
    property: stream.property,
    direction: stream.direction,
    summary: row.summary,
    related: row.related,
    original,
    statement: original,
    originalSlot: correction.slot,
    slot: correction.slot,
    currentPosition: position,
    proposedPosition: position,
    positionIsSlotKey,
    included: true,
    admitted: true,
    present: true,
  };
}

export function applyOrderingPosition(draft: OrderingDraft, position: string): OrderingDraft {
  if (orderingLocked(draft)) return draft;
  const statement = replacePosition(draft.original, position);
  const next = { ...draft, proposedPosition: position, statement, command: undefined, result: undefined };
  return { ...next, slot: proposedSlot(next) ?? next.originalSlot };
}

export function orderingChanged(draft: OrderingDraft): boolean {
  return draft.proposedPosition !== draft.currentPosition;
}

export function orderingPositionReady(draft: OrderingDraft): boolean {
  return draft.proposedPosition.length > 0;
}

export function orderingUncertain(result: OrderingResult | undefined): boolean {
  return !!result && !result.ok && (result.reason === 'unavailable' || result.retry === true);
}

export function orderingLocked(draft: OrderingDraft): boolean {
  return !!draft.result && (draft.result.ok || orderingUncertain(draft.result));
}

export function includedOrderingChanges(drafts: OrderingDraft[]): OrderingDraft[] {
  return drafts.filter(
    (draft) => draft.included && draft.admitted && orderingChanged(draft) && orderingPositionReady(draft) && !draft.result?.ok,
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? '';
}

export function orderingFingerprint(drafts: OrderingDraft[]): string {
  return canonical(
    includedOrderingChanges(drafts).map((draft) => ({
      key: draft.key,
      included: draft.included,
      proposedPosition: draft.proposedPosition,
      statement: draft.statement,
      slot: draft.slot,
    })),
  );
}

export function advanceOrderingReview(review: OrderingReview, fingerprint: string, jumpBack = false): OrderingReview {
  if (!fingerprint) return { status: 'closed' };
  if (jumpBack) return { status: 'stale', fingerprint };
  if (review.status === 'stale') return review;
  return { status: 'current', fingerprint };
}

export function pageOrderingDrafts(drafts: OrderingDraft[], streamKey: string, cursor?: string): OrderingDraft[] {
  const page = cursor ?? '';
  return drafts.filter((draft) => draft.streamKey === streamKey && draft.cursor === page);
}

export function stageOrderingSelection(
  drafts: OrderingDraft[],
  rows: PartRow[],
  stream: PartStream,
  selected: ReadonlySet<string>,
  cursor?: string,
): OrderingDraft[] {
  const page = pageOrderingDrafts(drafts, stream.key, cursor);
  const others = drafts.filter((draft) => draft.streamKey !== stream.key || draft.cursor !== (cursor ?? ''));
  const staged = new Map(page.map((draft) => [draft.key, draft]));
  for (const row of rows) {
    const key = orderingKey(row);
    const current = staged.get(key);
    if (!selected.has(key)) {
      if (current && !current.command && !orderingLocked(current)) staged.delete(key);
      else if (current) staged.set(key, { ...current, included: false });
      continue;
    }
    if (current) {
      staged.set(key, { ...current, included: true, summary: row.summary, related: row.related, present: true });
      continue;
    }
    if (staged.size >= orderingLimit) continue;
    const draft = stageOrderingRow(row, stream, cursor);
    if (draft) staged.set(key, draft);
  }
  return [...others, ...staged.values()];
}

export function markOrderingPresence(drafts: OrderingDraft[], rows: PartRow[]): OrderingDraft[] {
  const holders = new Set(rows.map((row) => row.holder));
  const assertions = new Set(rows.map(orderingKey));
  return drafts.map((draft) => ({
    ...draft,
    present: assertions.has(draft.key) ? true : holders.has(draft.holder) ? true : false,
  }));
}

export function concealOrderingCommands(drafts: OrderingDraft[]): OrderingDraft[] {
  return drafts.map((draft) =>
    draft.command && !draft.result
      ? { ...draft, result: { ...candidateFailure(503), retry: true } }
      : draft,
  );
}

export function admitOrderingDrafts(
  drafts: OrderingDraft[],
  stream: PartStream | undefined,
  rows: PartRow[],
  cursor?: string,
): OrderingDraft[] {
  if (!stream?.positionEditable)
    return drafts.map((draft) => ({
      ...draft,
      admitted: false,
      disabledReason: 'definition' as const,
      present: false,
    }));
  const present = new Map(rows.map((row) => [orderingKey(row), row]));
  const page = cursor ?? '';
  return drafts.map((draft) => {
    const onPage = draft.streamKey === stream.key && draft.cursor === page;
    const row = present.get(draft.key);
    if (!onPage || !row) {
      return {
        ...draft,
        admitted: false,
        disabledReason: 'unavailable' as const,
        present: false,
      };
    }
    const correction = partCorrection(row, stream);
    if (!correction)
      return {
        ...draft,
        admitted: false,
        disabledReason: 'definition' as const,
        present: true,
        summary: row.summary,
        related: row.related,
      };
    return {
      ...draft,
      admitted: true,
      disabledReason: undefined,
      present: true,
      summary: row.summary,
      related: row.related,
    };
  });
}

export function discardUnsentOrdering(drafts: OrderingDraft[], streamKey?: string, cursor?: string): OrderingDraft[] {
  const page = cursor ?? '';
  return drafts.filter((draft) => {
    if (streamKey !== undefined && (draft.streamKey !== streamKey || draft.cursor !== page)) return true;
    return !!draft.command || orderingLocked(draft);
  });
}

export function orderingOutcome(draft: OrderingDraft): OrderingOutcome | null {
  if (draft.result?.ok) return 'proposed';
  if (orderingUncertain(draft.result)) return 'uncertain';
  if (draft.result) return 'refused';
  return draft.included && orderingChanged(draft) ? 'editable' : null;
}

export function recordOrderingResult(draft: OrderingDraft, result: OrderingResult): OrderingDraft {
  if (result.ok || orderingUncertain(result)) return { ...draft, result };
  return { ...draft, result, command: undefined };
}

/** Seal only reviewed, admitted, changed holders. Successes keep their original command. */
export function sealOrdering(drafts: OrderingDraft[]): OrderingDraft[] {
  const pending = includedOrderingChanges(drafts);
  if (pending.length > orderingLimit) throw new Error('Invalid position set');
  return drafts.map((draft) => {
    if (!pending.includes(draft) || draft.command) return draft;
    const statement = replacePosition(draft.original, draft.proposedPosition);
    const slot = proposedSlot(draft) ?? writerSlot(draft.originalSlot);
    if (!slot)
      return {
        ...draft,
        statement,
        result: { ok: false, reason: 'invalid' } satisfies CandidateFailure,
      };
    return {
      ...draft,
      statement,
      slot,
      result: undefined,
      command: { id: draft.holder, slot, statement, key: crypto.randomUUID() },
    };
  });
}

export async function sendOrdering(
  drafts: OrderingDraft[],
  propose: (input: RelationProposal) => Promise<OrderingResult>,
  onResult: (key: string, result: OrderingResult) => void,
): Promise<void> {
  const pending = drafts.filter(
    (draft) => draft.included && draft.command && (!draft.result || orderingUncertain(draft.result)),
  );
  if (pending.length > orderingLimit) throw new Error('Invalid position set');
  await Promise.all(
    pending.map(async (draft) => {
      const command = draft.command!;
      let result: OrderingResult;
      try {
        result = await propose(orderingUncertain(draft.result) ? { ...command, retry: true } : command);
      } catch {
        result = { ...candidateFailure(503), retry: true };
      }
      onResult(draft.key, result);
    }),
  );
}
