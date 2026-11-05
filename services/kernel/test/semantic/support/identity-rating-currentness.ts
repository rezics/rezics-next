import type { CommandTransaction } from '../../../src/command/command.ts';

export type IdentityRatingAdmissionRow = Readonly<{
  subjectId: string | null;
  activeTerminal: boolean | null;
  redirect: string | null;
}>;

export function identityRatingAdmissionQuery(row: IdentityRatingAdmissionRow | null) {
  const queries: unknown[] = [];
  const client = {
    async query(...args: unknown[]) {
      queries.push(args[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    },
  };
  return { tx: client as unknown as CommandTransaction, queries };
}

export function queryText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (typeof query !== 'object' || query === null || !('text' in query)) return '';
  return String(query.text);
}
