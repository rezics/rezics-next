import { proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/library-import.test.ts';
export default rowOutcomes('books/library-import', {
  visitor: proved('signed-out requests cannot access private import operations', file),
  stranger: proved('another Person cannot access private import operations', file),
  member: proved('Realm membership adds no access to another Person imports', file),
  owner: proved('identified Book imports retain private records and replay without duplicate effects', file),
  moderator: proved('a joined Realm moderator cannot access another Person imports', file),
  operator: proved('platform authority alone cannot access another Person on ordinary import routes', file),
}, { rights: {
  basis: 'Owned original fictional Book metadata, reviews and private shelf curation; no public shelf or source adoption.',
  credit: 'The fixture owner is the original author and curator; private source fields retain that credit. Upload possession grants no authorship.',
} });
