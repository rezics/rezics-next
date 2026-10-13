import { proved, rowOutcomes } from '../../outcome-cells.ts';

const file = 'tests/qa/integration/outcomes/books/work-hub-and-edition-choice.test.ts';
export default rowOutcomes(
  'books/choose-among-mixed-formats-mixed-formats',
  {
    visitor: proved('compares paperback, ebook and audiobook; cannot persist anonymously', file),
    stranger: proved('persists each exact format pin without changing another reader; foreign Person GET/PUT is denied', file),
    member: proved('persists each exact format pin without changing another reader; foreign Person GET/PUT is denied', file),
    owner: proved('persists each exact format pin without changing another reader; foreign Person GET/PUT is denied', file),
    moderator: proved('persists each exact format pin without changing another reader; foreign Person GET/PUT is denied', file),
    operator: proved('uses ordinary reader routes for format pins; foreign Person GET/PUT is denied', file),
  },
  {
    rights: {
      basis: 'original-contribution',
      credit: 'Original fixture Book and three format descriptions by the fixture owner Person; native author credit is checked through HTTP. No external text, audio or covers.',
    },
  },
);
