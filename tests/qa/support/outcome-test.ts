import { test } from 'bun:test';
import {
  outcomeTitle,
  type Persona,
  type RowOutcomes,
} from '../../../scripts/qa/cases/outcome-cells.ts';

export function outcomeTest(
  declaration: RowOutcomes,
  persona: Persona,
  fn: Parameters<typeof test>[1],
): void {
  const title = outcomeTitle(declaration, persona);
  const cell = declaration.cells[persona]!;
  if (cell.state === 'pending') test.failing(title, fn);
  else test(title, fn);
}
