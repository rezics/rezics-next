import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/collection-tracking-and-progress.test.ts';
export default rowOutcomes('books/continue-progress-across-devices-two-device-progress', {
  visitor: proved('saved chapter progress requires authentication', file),
  stranger: pending('another reader cannot request the owner chapter progress', file),
  member: pending('Realm membership cannot request the owner chapter progress', file),
  owner: proved('two OAuth devices resume a volume chapter across its series and recover a stale save', file),
  moderator: pending('a joined Realm moderator cannot request the owner chapter progress', file),
  operator: pending('platform role on ordinary member routes cannot request the owner chapter progress', file),
}, { rights: {
  basis: 'original-contribution; private reader position is not published',
  credit: 'Synthetic Book and series text and structures authored by the fixture owner Person; no external source',
} });
