import { proved, rowOutcomes } from '../../outcome-cells.ts';

export default rowOutcomes('recipes/catalogue-pagination-in-its-zone', {
  visitor: proved('traverses all filtered public recipes once with honest terminal counts and query-bound continuations'),
  stranger: proved('traverses all filtered public recipes once with honest terminal counts and query-bound continuations'),
  member: proved('traverses all filtered public recipes without membership leaking hidden recipes through a cursor'),
  owner: proved('traverses all filtered public recipes while own private drafts remain excluded on every page'),
  moderator: proved('traverses all filtered public recipes without moderation leaking hidden recipes through a cursor'),
  operator: proved('traverses all filtered public recipes without platform authority leaking hidden recipes through a cursor'),
}, { rights: { basis: 'original-contribution', credit: 'Original synthetic recipe text and arrangement by the owner Person, with native author credit.' } });
