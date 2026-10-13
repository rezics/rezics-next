import { test } from 'bun:test';
import {
  outcomeTitle,
  type Persona,
  type RowOutcomes,
} from '../../../scripts/qa/cases/outcome-cells.ts';

/** A background read gets 45 seconds by default, repeating only its public refusal. */
export async function outcomeResponse(
  request: (signal: AbortSignal) => Promise<Response>,
  deadlineMs = 45_000,
): Promise<Response> {
  const signal = AbortSignal.timeout(deadlineMs);
  for (;;) {
    const response = await request(signal);
    if (response.status !== 503) return response;
    const problem = await response.clone().json() as { code?: string };
    if (problem.code !== 'work_read_unavailable' || signal.aborted) return response;
    await response.body?.cancel();
  }
}

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
