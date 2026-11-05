import type { Release } from '@rezics/definitions';
import type { CreatedReader } from './create-subject';
import {
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import { isScreenType, screenFactId, type ScreenItem } from './screen-profile';
import type { StatementInput } from './statement-editor';
import { factHolder, type FactDraft, type FactsCurrent } from './subject-facts';

export type ScreenDraftRow = { key: string; statement: StatementInput };
export type ScreenReuseState = {
  type: string;
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

export function screenHolder(row: ScreenDraftRow): string {
  return `${screenFactId(row.statement.property.id)}-${row.key}`;
}

export function screenFactDrafts(rows: readonly ScreenDraftRow[]): FactDraft[] {
  return rows.map((row) => ({
    holder: screenHolder(row),
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function screenFactsFromDrafts(drafts: FactDraft[], rows: ScreenDraftRow[]): ScreenDraftRow[] {
  const byHolder = new Map(drafts.map((draft) => [factHolder(draft), draft]));
  return rows.map((row) => {
    const draft = byHolder.get(screenHolder(row));
    return draft ? { ...row, statement: draft.statement } : row;
  });
}

/** Creation has no public subject; reuse and statement fields need only the Type and related map. */
export function screenCreateFactsRead(release: Release, type: string): FactsCurrent {
  return {
    ok: true,
    release,
    source: null,
    public: { subject: { type }, related: {} },
  } as FactsCurrent;
}

export function screenAdmitCreatedReader(reader: CreatedReader, id: string): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (!identity || identity.id !== id || !isScreenType(identity.type)) return { state: 'stale' };
  return reader;
}

export function captureScreenReuse(
  rows: readonly ScreenDraftRow[],
  type: string,
  row: ScreenDraftRow,
  index: number,
): ScreenReuseState | null {
  const group = row.statement.references[index];
  if (!group) return null;
  const source = {
    holder: screenHolder(row),
    property: row.statement.property.id,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    type,
    source,
    selected: [],
    capture: captureReuse(source, screenFactDrafts(rows)),
    applied: [],
    refused: [],
  };
}

export function screenStructuredParts(item: Pick<ScreenItem, 'statements'>): number {
  let count = 0;
  for (const rows of Object.values(item.statements ?? {})) {
    for (const statement of rows) {
      count += 1 + (statement.qualifiers?.length ?? 0);
      for (const reference of statement.references) count += reference.parts.length;
    }
  }
  return count;
}

export function screenDraftStructuredParts(rows: readonly ScreenDraftRow[]): number {
  let count = 0;
  for (const row of rows) {
    count += 1 + (row.statement.qualifiers?.length ?? 0);
    for (const reference of row.statement.references) count += reference.parts.length;
  }
  return count;
}
