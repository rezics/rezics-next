import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/collection-tracking-and-progress.test.ts';
export default rowOutcomes('books/collection-tracking-and-progress', {
  visitor: proved('signed-out state is empty and private writes are refused', file),
  stranger: pending('another reader cannot change the owner library or progress', file),
  member: pending('Realm membership cannot change the owner library or progress', file),
  owner: pending('Book status, totals and chapter continuation survive replay and stale writes', file),
  moderator: pending('a joined Realm moderator cannot change the owner library or progress', file),
  operator: pending('platform role on ordinary member routes cannot change the owner library or progress', file),
}, { rights: {
  basis: 'original-contribution; private reader state is not published',
  credit: 'Synthetic Book text and structures authored by the fixture owner Person; no external source',
} });
