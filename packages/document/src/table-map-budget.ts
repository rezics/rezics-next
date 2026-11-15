// SPDX-License-Identifier: Apache-2.0
import type { DocumentNode } from './types.ts';

/** Maximum proven dense map entries for one Blocks-profile table. */
export const DOCUMENT_TABLE_MAP_CELL_BUDGET = 65_536;

function safeAdd(left: number, right: number): number | null {
  const result = left + right;
  return Number.isSafeInteger(result) ? result : null;
}

function safeMultiply(left: number, right: number): number | null {
  const result = left * right;
  return Number.isSafeInteger(result) ? result : null;
}

/**
 * Prove the dense TableMap bound from each row's new cells and active rowspans.
 * A row-end sweep counts carried columns without constructing a ProseMirror node or map.
 */
export function tableMapFitsBudget(table: DocumentNode, budget: number): boolean {
  if (!Number.isSafeInteger(budget) || budget < 0 || table.type !== 'table') return false;
  const rows = table.content;
  if (!rows?.length || rows.length > budget || rows.length > DOCUMENT_TABLE_MAP_CELL_BUDGET) return false;

  const endingColumnSpans = new Array<number>(rows.length + 1).fill(0);
  const maximumWidth = Math.floor(budget / rows.length);
  let activeColumnSpan = 0;
  let widestRow = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    if (row.type !== 'tableRow') return false;
    let rowWidth = activeColumnSpan - endingColumnSpans[rowIndex]!;
    for (const cell of row.content ?? []) {
      if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') return false;
      const rawColspan = cell.attrs?.colspan;
      const rawRowspan = cell.attrs?.rowspan;
      const colspan = rawColspan === undefined ? 1 : rawColspan;
      const rowspan = rawRowspan === undefined ? 1 : rawRowspan;
      if (
        typeof colspan !== 'number' ||
        !Number.isSafeInteger(colspan) ||
        colspan < 1 ||
        typeof rowspan !== 'number' ||
        !Number.isSafeInteger(rowspan) ||
        rowspan < 1 ||
        rowspan > rows.length - rowIndex
      )
        return false;
      const nextWidth = safeAdd(rowWidth, colspan);
      if (nextWidth === null || nextWidth > maximumWidth) return false;
      rowWidth = nextWidth;

      const endRow = rowIndex + rowspan;
      const nextEnding = safeAdd(endingColumnSpans[endRow]!, colspan);
      if (nextEnding === null) return false;
      endingColumnSpans[endRow] = nextEnding;
    }
    widestRow = Math.max(widestRow, rowWidth);
    activeColumnSpan = rowWidth;
  }

  const expandedCells = safeMultiply(rows.length, widestRow);
  return widestRow > 0 && expandedCells !== null && expandedCells <= budget;
}

/** Check all tables in a block before ProseMirror can create a dense TableMap. */
export function blockTablesFitBudget(block: DocumentNode, budget = DOCUMENT_TABLE_MAP_CELL_BUDGET): boolean {
  if (block.type === 'table' && !tableMapFitsBudget(block, budget)) return false;
  return (block.content ?? []).every((child) => blockTablesFitBudget(child, budget));
}
