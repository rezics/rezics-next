import type { Release } from '@rezics/definitions';
import type { CreatedReader } from './create-subject';
import {
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { isLiteraryType, type LiteraryItem } from './literary-profile';
import type { StatementInput } from './statement-editor';
import { factHolder, type FactDraft, type FactsCurrent } from './subject-facts';

export type LiteraryDraftRow = { id: string; statement: StatementInput };
export type LiteraryReuseState = {
  type: string;
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

export function literaryHolder(row: Pick<LiteraryDraftRow, 'id'>): string {
  return `literary-fact-${row.id}`;
}

export function literaryFactDrafts(rows: readonly LiteraryDraftRow[]): FactDraft[] {
  return rows.map((row) => ({
    holder: literaryHolder(row),
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function literaryFactsFromDrafts(drafts: FactDraft[], rows: LiteraryDraftRow[]): LiteraryDraftRow[] {
  const byHolder = new Map(drafts.map((draft) => [factHolder(draft), draft]));
  return rows.map((row) => {
    const draft = byHolder.get(literaryHolder(row));
    return draft ? { ...row, statement: draft.statement } : row;
  });
}

/** Creation has no public subject; reuse and statement fields need only the Type and related map. */
export function literaryCreateFactsRead(release: Release, type: string): FactsCurrent {
  return {
    ok: true,
    release,
    source: null,
    public: { subject: { type }, related: {} },
  } as FactsCurrent;
}

export function literaryAdmitCreatedReader(reader: CreatedReader, id: string, expectedType: string): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (!identity || identity.id !== id || !isLiteraryType(identity.type) || identity.type !== expectedType)
    return { state: 'stale' };
  return reader;
}

export function captureLiteraryReuse(
  rows: readonly LiteraryDraftRow[],
  type: string,
  row: LiteraryDraftRow,
  index: number,
): LiteraryReuseState | null {
  const group = row.statement.references[index];
  if (!group) return null;
  const source = {
    holder: literaryHolder(row),
    property: row.statement.property.id,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    type,
    source,
    selected: [],
    capture: captureReuse(source, literaryFactDrafts(rows)),
    applied: [],
    refused: [],
  };
}

export function literaryStructuredParts(item: Pick<LiteraryItem, 'statements'>): number {
  let count = 0;
  for (const rows of Object.values(item.statements ?? {})) {
    for (const statement of rows) {
      count += 1 + (statement.qualifiers?.length ?? 0);
      for (const reference of statement.references) count += reference.parts.length;
    }
  }
  return count;
}

export function literaryDraftStructuredParts(rows: readonly LiteraryDraftRow[]): number {
  let count = 0;
  for (const row of rows) {
    count += 1 + (row.statement.qualifiers?.length ?? 0);
    for (const reference of row.statement.references) count += reference.parts.length;
  }
  return count;
}
