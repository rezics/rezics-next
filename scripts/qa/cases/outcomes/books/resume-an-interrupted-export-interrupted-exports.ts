import { proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/library-import.test.ts';
export default rowOutcomes(
  'books/resume-an-interrupted-export-interrupted-exports',
  {
    visitor: proved('copied continuation tokens cannot authenticate a visitor', file),
    stranger: proved('copied continuation tokens cannot authorize or bind another Person', file),
    member: proved('Realm membership cannot authorize copied Book continuation tokens', file),
    owner: proved(
      'a dropped Book page resumes without loss or duplicates and a changed basis requires restart',
      file,
    ),
    moderator: proved(
      'joined Realm moderation cannot authorize copied Book continuation tokens',
      file,
    ),
    operator: proved(
      'platform authority cannot authorize another Person continuation on the ordinary member route',
      file,
    ),
  },
  {
    rights: {
      basis:
        'original-contribution for the public fixture Book text; private continuation of owned original records within a live unchanged unexpired basis.',
      credit:
        'Original fixture author and curator are preserved; snapshot and cursor confer no authority or authorship.',
    },
  },
);
