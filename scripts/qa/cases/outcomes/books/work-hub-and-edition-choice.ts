import { proved, rowOutcomes } from '../../outcomes.ts';

const file = 'tests/qa/integration/outcomes/books/work-hub-and-edition-choice.test.ts';
export default rowOutcomes('books/work-hub-and-edition-choice', {
  visitor: proved('reads the public Book and editions; private choice requires sign-in', file),
  stranger: proved('pins an own edition and continuation; foreign Person GET/PUT is denied', file),
  member: proved('pins an own edition and continuation; foreign Person GET/PUT is denied', file),
  owner: proved('pins an own edition and continuation; foreign Person GET/PUT is denied', file),
  moderator: proved('pins an own edition and continuation; foreign Person GET/PUT is denied', file),
  operator: proved('uses ordinary reader routes with own Person control; foreign GET/PUT is denied', file),
}, { rights: { basis: 'original-contribution', credit: 'Original fixture text by the fixture owner Person; native author credit is checked through HTTP.' } });
