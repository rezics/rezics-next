import { proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/collection-tracking-and-progress.test.ts';
export default rowOutcomes('books/collection-tracking-and-progress', {
  visitor: proved('signed-out state is empty and private writes are refused', file),
  stranger: proved('another reader cannot change the owner library or progress', file),
  member: proved('Realm membership cannot change the owner library or progress', file),
  owner: proved('Book status, totals and chapter continuation survive replay and stale writes', file),
  moderator: proved('a joined Realm moderator cannot change the owner library or progress', file),
  operator: proved('platform role on ordinary member routes cannot change the owner library or progress', file),
}, { rights: {
  basis: 'original-contribution; private reader state is not published',
  credit: 'Synthetic Book text and structures authored by the fixture owner Person; no external source',
} });
