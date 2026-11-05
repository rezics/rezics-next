export type StatementRepetitionSummary<T> = {
  readonly entries: readonly T[];
  readonly repetitions: readonly number[];
  readonly node?: string;
};

export type StatementRepetitionIndex<T> = {
  readonly repetitionCount: number;
  readonly statements: ReadonlyMap<string, StatementRepetitionSummary<T>>;
};

type MutableSummary<T> = {
  entries: T[];
  repetitions: number[];
  node?: string;
  lastRun: number;
};

/** Indexes each captured entry once, keeping the first value and last named node per statement and repetition. */
export function indexStatementRepetitions<T extends { readonly statement: string; readonly node?: string }>(
  runs: readonly (readonly T[])[],
): StatementRepetitionIndex<T> {
  const accumulated = new Map<string, MutableSummary<T>>();
  for (let runIndex = 0; runIndex < runs.length; runIndex++)
    for (const entry of runs[runIndex]!) {
      let summary = accumulated.get(entry.statement);
      if (!summary) {
        summary = { entries: [], repetitions: [], lastRun: -1 };
        accumulated.set(entry.statement, summary);
      }
      if (summary.lastRun !== runIndex) {
        summary.entries.push(entry);
        summary.repetitions.push(runIndex + 1);
        summary.lastRun = runIndex;
      }
      if (entry.node) summary.node = entry.node;
    }

  const statements = new Map<string, StatementRepetitionSummary<T>>();
  for (const [statement, { entries, repetitions, node }] of accumulated)
    statements.set(statement, { entries, repetitions, ...(node === undefined ? {} : { node }) });
  return { repetitionCount: runs.length, statements };
}
