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
 * Prove a table's conservative expanded-grid bound without constructing a ProseMirror node or map.
 * TableMap's width is no greater than the sum of every cell's colspan; its height is the row count.
 */
export function tableMapFitsBudget(table: DocumentNode, budget: number): boolean {
  if (!Number.isSafeInteger(budget) || budget < 0 || table.type !== 'table') return false;
  const rows = table.content;
  if (!rows?.length) return false;

  let totalColumnSpan = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    if (row.type !== 'tableRow' || !row.content?.length) return false;
    for (const cell of row.content) {
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
      const nextTotal = safeAdd(totalColumnSpan, colspan);
      if (nextTotal === null) return false;
      totalColumnSpan = nextTotal;
    }
  }

  const expandedCells = safeMultiply(rows.length, totalColumnSpan);
  return expandedCells !== null && expandedCells <= budget;
}

/** Check all tables in a block before ProseMirror can create a dense TableMap. */
export function blockTablesFitBudget(block: DocumentNode, budget = DOCUMENT_TABLE_MAP_CELL_BUDGET): boolean {
  if (block.type === 'table' && !tableMapFitsBudget(block, budget)) return false;
  return (block.content ?? []).every((child) => blockTablesFitBudget(child, budget));
}
