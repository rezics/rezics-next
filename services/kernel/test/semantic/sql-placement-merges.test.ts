import { guardStatements } from './support/sql-guard.ts';

guardStatements('merges and links', [
  'merges.ts',
  'reviewed-person-identity.ts',
  'slots.ts',
  'merge-moves.ts',
  'links.ts',
]);
