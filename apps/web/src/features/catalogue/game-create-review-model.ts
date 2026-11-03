import type { Release } from '@rezics/definitions';
import type { CreatedReader } from './create-subject';
import {
  applyReuse,
  captureReuse,
  cloneReferenceGroup,
  type ReuseCapture,
  type ReuseRefusal,
  type ReuseSource,
} from './reference-reuse';
import type { SnakInput, StatementInput } from './statement-editor';
import { factHolder, type FactDraft } from './subject-facts';
import { gameFields, gameType, type GameItem } from './game-profile';

export type GameCreateRow = { key: string; statement: StatementInput };
export type GameCreateGrain = 'work' | 'addon' | 'release';
export type GameCreateReuseState = {
  source: ReuseSource;
  selected: string[];
  capture: ReuseCapture;
  applied: { holder: string; property: string; index: number }[];
  refused: { holder: string; property: string; reason: ReuseRefusal }[];
};

export function gameCreateHolder(key: string): string {
  return `game-initial-${key}`;
}

export function gameCreateDrafts(rows: readonly GameCreateRow[]): FactDraft[] {
  return rows.map((row) => ({
    holder: gameCreateHolder(row.key),
    property: row.statement.property.id,
    source: null,
    baseline: null,
    statement: row.statement,
    included: true,
  }));
}

export function gameCreateRowsFromDrafts(
  drafts: readonly FactDraft[],
  rows: readonly GameCreateRow[],
): GameCreateRow[] {
  const keys = new Map(rows.map((row) => [gameCreateHolder(row.key), row.key]));
  return drafts.map((draft) => ({
    key: keys.get(factHolder(draft)) ?? factHolder(draft).replace(/^game-initial-/, ''),
    statement: draft.statement,
  }));
}

export function captureGameCreateReuse(
  rows: readonly GameCreateRow[],
  key: string,
  index: number,
): GameCreateReuseState | null {
  const row = rows.find((entry) => entry.key === key);
  const group = row?.statement.references[index];
  if (!row || !group) return null;
  const source = {
    holder: gameCreateHolder(row.key),
    property: row.statement.property.id,
    groupIndex: index,
    snapshot: cloneReferenceGroup(group),
  };
  return {
    source,
    selected: [],
    capture: captureReuse(source, gameCreateDrafts(rows)),
    applied: [],
    refused: [],
  };
}

export function applyGameCreateReuse(
  rows: readonly GameCreateRow[],
  reuse: GameCreateReuseState,
  release: Release,
): { rows: GameCreateRow[]; reuse: GameCreateReuseState } {
  const result = applyReuse(gameCreateDrafts(rows), reuse.source, reuse.selected, release);
  return {
    rows: gameCreateRowsFromDrafts(result.drafts, rows),
    reuse: { ...reuse, applied: result.applied, refused: result.refused },
  };
}

/** Grain follows the current Type descriptor; admission stays on gameType/gameDefinitions. */
export function gameCreateGrain(release: Release, type: string): GameCreateGrain {
  const bases = release.types[type]?.bases ?? [];
  if (type === 'wd:Q20631656' || bases.includes('wd:Q20631656')) return 'release';
  if (type === 'wd:Q209163' || bases.includes('wd:Q209163')) return 'addon';
  return 'work';
}

export function gameAdmitCreatedReader(reader: CreatedReader, id: string, release: Release): CreatedReader {
  if (reader.state !== 'ready') return reader;
  const identity = reader.identity;
  if (!identity || identity.id !== id || !gameType(release, identity.type)) return { state: 'stale' };
  return reader;
}

export function gameCreateUnsupported(item: GameItem, release: Release): string[] {
  const admitted = gameFields(release, item.type);
  return Object.keys(item.statements).filter((property) => !admitted.includes(property));
}

export function visitGameCreateParts(rows: readonly GameCreateRow[], visit: (part: SnakInput) => void): number {
  let count = 0;
  for (const row of rows) {
    visit(row.statement);
    count += 1;
    for (const qualifier of row.statement.qualifiers ?? []) {
      visit(qualifier);
      count += 1;
    }
    for (const reference of row.statement.references) {
      for (const part of reference.parts) {
        visit(part);
        count += 1;
      }
    }
  }
  return count;
}

export function gameCreateNativeContent(part: SnakInput, datatype: string | undefined): string | undefined {
  const content = part.value.type === 'value' ? part.value.content : undefined;
  if (datatype === 'wikibase-item' && typeof content === 'string') return content;
  if ((datatype === 'time' || datatype === 'quantity') && content && typeof content === 'object')
    return JSON.stringify(content);
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') return JSON.stringify(content);
  return undefined;
}
