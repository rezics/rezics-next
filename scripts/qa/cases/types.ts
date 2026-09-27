export interface Case {
  id: string;
  page: string;
}

export interface DeclaredCase extends Case {
  scenario: string;
  requiredResult: string;
}

export function defineCases(
  page: string,
  rows: readonly Omit<DeclaredCase, 'page'>[],
): readonly DeclaredCase[] {
  return rows.map((row) => ({ ...row, page }));
}
