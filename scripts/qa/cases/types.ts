export interface Case {
  id: string;
  page: string;
}

export interface DeclaredCase extends Case {
  scenario: string;
  requiredResult: string;
}

/** Additional obligations under existing IDs. These do not enter qualified coverage until tested. */
export interface PendingSubcase {
  caseIds: readonly [string, ...string[]];
  scenario: string;
  requiredResult: string;
  status: 'pending';
}

export function defineCases(
  page: string,
  rows: readonly Omit<DeclaredCase, 'page'>[],
): readonly DeclaredCase[] {
  return rows.map((row) => ({ ...row, page }));
}
