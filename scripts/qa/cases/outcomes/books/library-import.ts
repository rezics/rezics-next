import { pending, proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/library-import.test.ts';
export default rowOutcomes(
  'books/library-import',
  {
    visitor: proved('signed-out requests cannot access private import operations', file),
    stranger: proved('another Person cannot access private import operations', file),
    member: proved('Realm membership adds no access to another Person imports', file),
    owner: pending(
      'identified Book imports retain private records, replay commands and reimport own shelves without copies',
      file,
    ),
    moderator: proved('a joined Realm moderator cannot access another Person imports', file),
    operator: proved(
      'platform authority alone cannot access another Person on ordinary import routes',
      file,
    ),
  },
  {
    rights: {
      basis:
        'original-contribution for the public fixture Book text; owned original metadata, private reviews and shelf curation; no public shelf or source adoption.',
      credit:
        'The fixture owner is the original author and curator; private source fields retain that credit. Upload possession grants no authorship.',
    },
  },
);
