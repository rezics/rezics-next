import { proved, rowOutcomes } from '../../outcomes.ts';

const file = 'tests/qa/integration/outcomes/books/work-hub-and-edition-choice.test.ts';
export default rowOutcomes('books/choose-among-ambiguous-editions-of-one-work-ambiguous-editions', {
  visitor: proved('distinguishes same-title release identities; cannot persist anonymously', file),
  stranger: proved('persists distinct same-title pins; foreign Person GET/PUT is denied', file),
  member: proved('persists distinct same-title pins; foreign Person GET/PUT is denied', file),
  owner: proved('persists distinct same-title pins; foreign Person GET/PUT is denied', file),
  moderator: proved('persists distinct same-title pins; foreign Person GET/PUT is denied', file),
  operator: proved('uses ordinary reader routes for exact pins; foreign Person GET/PUT is denied', file),
}, { rights: { basis: 'original-contribution', credit: 'Original fixture Book and edition metadata by the fixture owner Person; no external text, audio or covers.' } });
