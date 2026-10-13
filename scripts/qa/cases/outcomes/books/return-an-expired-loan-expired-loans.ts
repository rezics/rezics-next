import { proved, rowOutcomes } from '../../outcomes.ts';

// Registration draft: the QA planner blocks execution; these cells are not certified.
const file = 'tests/qa/integration/outcomes/books/collection-tracking-and-progress.test.ts';
export default rowOutcomes('books/return-an-expired-loan-expired-loans', {
  visitor: proved('an overdue loan cannot be read or returned without authentication', file),
  stranger: proved('another reader cannot read or return the owner overdue loan', file),
  member: proved('Realm membership cannot read or return the owner overdue loan', file),
  owner: proved('returning an overdue loan without extension releases its copy and preserves history and replay', file),
  moderator: proved('a joined Realm moderator cannot read or return the owner overdue loan', file),
  operator: proved('platform role on ordinary member routes cannot read or return the owner overdue loan', file),
}, { rights: {
  basis: 'original-contribution for the fixture Book; overdue loans and returns stay private',
  credit: 'Synthetic Book text authored by the fixture owner Person; no external source',
} });
