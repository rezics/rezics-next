import { proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/collection-tracking-and-progress.test.ts';
export default rowOutcomes('books/loans', {
  visitor: proved('private copies and loans require authentication', file),
  stranger: proved('another reader cannot list copies or open, extend or return the owner loan', file),
  member: proved('Realm membership cannot list copies or open, extend or return the owner loan', file),
  owner: proved('exact Book release copies support private lending, replay, extension and return', file),
  moderator: proved('a joined Realm moderator cannot list copies or open, extend or return the owner loan', file),
  operator: proved('platform role on ordinary member routes cannot list copies or open, extend or return the owner loan', file),
}, { rights: {
  basis: 'original-contribution for the fixture Book; copies and loans stay private',
  credit: 'Synthetic Book text authored by the fixture owner Person; no external source',
} });
