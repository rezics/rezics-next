import { proved, rowOutcomes } from '../../outcomes.ts';

const file = 'tests/qa/integration/outcomes/books/library-import.test.ts';
export default rowOutcomes('books/library-export', {
  visitor: proved('signed-out requests cannot export a private Book library', file),
  stranger: proved('another Person cannot export the owner Book library', file),
  member: proved('Realm membership adds no access to the owner Book export', file),
  owner: proved('every retained Book record traverses and reimports with private meaning intact', file),
  moderator: proved('a joined Realm moderator cannot export the owner Book library', file),
  operator: proved('platform authority alone cannot export another Person on the ordinary member route', file),
}, { rights: {
  basis: 'Private export and reimport of owned original fixture records; no publication or active lending effects.',
  credit: 'Original fixture author and curator remain the owner; copied bundles confer neither Person control nor publication rights.',
} });
