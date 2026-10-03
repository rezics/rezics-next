export interface CapturedFusekiQuery {
  path?: string;
  sparql: string;
  result?: unknown;
}
export interface FusekiCandidates {
  variable: string;
  /** Unique reported values; never sum repeated metadata into a candidate total. */
  counts: number[] | null;
  returnedBindings: number | null;
  basis: 'query-reported candidates; not native Lucene/TDB2 operator visits';
}

/** Missing counters stay unknown, even when a query returns zero result rows. */
export function fusekiCandidateCounts(
  result: unknown,
  variable = 'candidateCount',
): FusekiCandidates {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
    throw new Error('Invalid candidate count variable');
  const value = result as { results?: { bindings?: Record<string, { value?: string }>[] } } | null;
  const rows = value?.results?.bindings;
  const metadata = {
    variable,
    returnedBindings: Array.isArray(rows) ? rows.length : null,
    basis: 'query-reported candidates; not native Lucene/TDB2 operator visits' as const,
  };
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.some(
      (row) =>
        !row ||
        typeof row !== 'object' ||
        !row[variable] ||
        !/^(0|[1-9][0-9]*)$/.test(row[variable]!.value ?? '') ||
        !Number.isSafeInteger(Number(row[variable]!.value)),
    )
  )
    return { ...metadata, counts: null };
  return { ...metadata, counts: [...new Set(rows.map((row) => Number(row[variable]!.value)))] };
}
